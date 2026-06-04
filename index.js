const Afip = require("@afipsdk/afip.js");
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const TZ_ARGENTINA = "America/Argentina/Buenos_Aires";
const SQL_HOY_ARGENTINA = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

function fechaArgentinaISO() {
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ_ARGENTINA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const mapa = Object.fromEntries(partes.map(p => [p.type, p.value]));
  return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function fechaAfipArgentina() {
  return Number(fechaArgentinaISO().replace(/-/g, ""));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function normalizarCertificado(valor) {
  return String(valor || "").replace(/\\n/g, "\n").trim();
}

const afip = new Afip({
  CUIT: Number(process.env.AFIP_CUIT || 20920936300),
  access_token: process.env.AFIPSDK_ACCESS_TOKEN,
  cert: normalizarCertificado(process.env.AFIP_CERT),
  key: normalizarCertificado(process.env.AFIP_KEY),
  production: true
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("."));

function n2(valor) {
  return Number(Number(valor || 0).toFixed(2));
}

function n3(valor) {
  return Number(Number(valor || 0).toFixed(3));
}

function redondearPrecio(valor, tipoRedondeo = "100") {
  const precio = Number(valor || 0);
  if (!Number.isFinite(precio) || precio <= 0) return 0;

  const tipo = String(tipoRedondeo || "100");
  if (tipo === "ninguno" || tipo === "0" || tipo === "sin") {
    return n2(precio);
  }

  if (tipo === "50") {
    return n2(Math.round(precio / 50) * 50);
  }

  const base = Math.floor(precio / 100) * 100;
  const resto = precio - base;
  return resto <= 30 ? base : base + 100;
}

function costoUnitarioDesdeBulto(costo, cantidadBulto) {
  const costoNum = n2(costo);
  let bulto = n3(cantidadBulto || 1);
  if (!Number.isFinite(bulto) || bulto <= 0) bulto = 1;
  return n2(costoNum / bulto);
}

function calcularPrecioVenta(costo, porcentajeGanancia, precioVentaInformado, cantidadBulto = 1, tipoRedondeo = "100") {
  const costoUnitario = costoUnitarioDesdeBulto(costo, cantidadBulto);
  const gananciaNum = n2(porcentajeGanancia);
  const precioInformado = n2(precioVentaInformado);

  if (precioInformado > 0) return precioInformado;
  if (costoUnitario > 0 && gananciaNum >= 0) {
    return n2(redondearPrecio(costoUnitario * (1 + gananciaNum / 100), tipoRedondeo));
  }
  return 0;
}

async function recalcularPresentacionesProducto(clientOrPool, productoId, precioBase) {
  const precio = n2(precioBase);
  await clientOrPool.query(
    `
    UPDATE producto_presentaciones
    SET
      precio_venta = ROUND(($1::numeric * factor)::numeric, 2),
      updated_at = NOW()
    WHERE producto_id = $2
      AND activo = true
      AND es_venta = true
    `,
    [precio, productoId]
  );
}

function vacio(valor) {
  return valor === undefined || valor === null || String(valor).trim() === "";
}

async function buscarCajaAbierta(empleadoId = null) {
  if (empleadoId) {
    const result = await pool.query(
      `
      SELECT *
      FROM caja_sesiones
      WHERE estado = 'abierta'
        AND empleado_apertura_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [empleadoId]
    );
    return result.rows[0] || null;
  }

  const result = await pool.query(`
    SELECT *
    FROM caja_sesiones
    WHERE estado = 'abierta'
    ORDER BY id DESC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

async function registrarActividadEmpleado(clientOrPool, empleadoId) {
  if (!empleadoId) return;
  await clientOrPool.query(
    `
    UPDATE empleados
    SET ultima_actividad = NOW()
    WHERE id = $1
    `,
    [empleadoId]
  ).catch(() => {});
}


async function asegurarColumnasAlmacen() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(255) NOT NULL,
      telefono VARCHAR(80) DEFAULT '',
      direccion TEXT DEFAULT '',
      activo BOOLEAN DEFAULT true,
      observaciones TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE proveedores
    ADD COLUMN IF NOT EXISTS telefono VARCHAR(80) DEFAULT '',
    ADD COLUMN IF NOT EXISTS direccion TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS observaciones TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE empleados
    ADD COLUMN IF NOT EXISTS puede_recetas BOOLEAN DEFAULT false
  `);

  await pool.query(`
    ALTER TABLE empleados
    ADD COLUMN IF NOT EXISTS ultima_actividad TIMESTAMP
  `);

  await pool.query(`
    UPDATE empleados
    SET puede_recetas = true
    WHERE rol = 'admin' OR puede_configuracion = true
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recetas_producciones (
      id SERIAL PRIMARY KEY,
      producto_final_id INTEGER REFERENCES productos(id),
      cantidad_final NUMERIC NOT NULL DEFAULT 0,
      empleado_id INTEGER REFERENCES empleados(id),
      observaciones TEXT DEFAULT '',
      fecha TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recetas_produccion_detalle (
      id SERIAL PRIMARY KEY,
      produccion_id INTEGER REFERENCES recetas_producciones(id) ON DELETE CASCADE,
      producto_insumo_id INTEGER REFERENCES productos(id),
      cantidad NUMERIC NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS cantidad_bulto NUMERIC DEFAULT 1
  `);

  await pool.query(`
    UPDATE productos
    SET cantidad_bulto = 1
    WHERE cantidad_bulto IS NULL OR cantidad_bulto <= 0
  `);

  await pool.query(`
    ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS tipo_redondeo VARCHAR(20) DEFAULT '100'
  `);

  await pool.query(`
    UPDATE productos
    SET tipo_redondeo = '100'
    WHERE tipo_redondeo IS NULL OR tipo_redondeo = ''
  `);
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'productos'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%tipo_venta%'
      LOOP
        EXECUTE format('ALTER TABLE productos DROP CONSTRAINT IF EXISTS %I', r.conname);
      END LOOP;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE productos
    ADD CONSTRAINT productos_tipo_venta_check
    CHECK (tipo_venta IN ('unidad', 'peso', 'receta'))
  `).catch(() => {});


  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(255) NOT NULL,
      telefono VARCHAR(80) DEFAULT '',
      direccion TEXT DEFAULT '',
      limite_credito NUMERIC DEFAULT 0,
      activo BOOLEAN DEFAULT true,
      observaciones TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuenta_corriente_movimientos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      venta_id INTEGER,
      tipo VARCHAR(30) NOT NULL,
      monto NUMERIC NOT NULL DEFAULT 0,
      observaciones TEXT DEFAULT '',
      empleado_id INTEGER,
      fecha TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE ventas
    ADD COLUMN IF NOT EXISTS cliente_id INTEGER
  `);

  await pool.query(`
    ALTER TABLE caja_sesiones
    ADD COLUMN IF NOT EXISTS caja_esperada NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_efectivo NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_transferencia NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_cuenta_corriente NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS transferencia_real NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_debito NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_credito NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingresos_manuales NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retiros NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingresos_efectivo NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingresos_transferencia NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retiros_efectivo NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retiros_transferencia NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS transferencia_esperada NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS diferencia_transferencia NUMERIC DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE caja_movimientos
    ADD COLUMN IF NOT EXISTS medio_pago VARCHAR(30) DEFAULT 'efectivo'
  `);

  await pool.query(`
    UPDATE caja_movimientos
    SET medio_pago = 'efectivo'
    WHERE medio_pago IS NULL OR TRIM(medio_pago) = ''
  `);
}

async function calcularResumenCaja(clientOrPool, cajaSesionId) {
  const cajaResult = await clientOrPool.query(
    `
    SELECT
      cs.*,
      ea.nombre AS empleado_apertura_nombre,
      ec.nombre AS empleado_cierre_nombre
    FROM caja_sesiones cs
    LEFT JOIN empleados ea ON ea.id = cs.empleado_apertura_id
    LEFT JOIN empleados ec ON ec.id = cs.empleado_cierre_id
    WHERE cs.id = $1
    LIMIT 1
    `,
    [cajaSesionId]
  );

  const caja = cajaResult.rows[0] || null;
  if (!caja) return null;

  const movimientosResult = await clientOrPool.query(
    `
    SELECT
      COALESCE(SUM(CASE WHEN tipo = 'venta_efectivo' THEN monto ELSE 0 END), 0) AS ventas_efectivo,
      COALESCE(SUM(CASE WHEN tipo = 'venta_transferencia' THEN monto ELSE 0 END), 0) AS ventas_transferencia,
      COALESCE(SUM(CASE WHEN tipo = 'venta_cuenta_corriente' THEN monto ELSE 0 END), 0) AS ventas_cuenta_corriente,
      COALESCE(SUM(CASE WHEN tipo = 'venta_debito' THEN monto ELSE 0 END), 0) AS ventas_debito,
      COALESCE(SUM(CASE WHEN tipo = 'venta_credito' THEN monto ELSE 0 END), 0) AS ventas_credito,
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos_manuales,
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' AND COALESCE(medio_pago, 'efectivo') = 'efectivo' THEN monto ELSE 0 END), 0) AS ingresos_efectivo,
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' AND COALESCE(medio_pago, 'efectivo') = 'transferencia' THEN monto ELSE 0 END), 0) AS ingresos_transferencia,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' THEN monto ELSE 0 END), 0) AS retiros,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' AND COALESCE(medio_pago, 'efectivo') = 'efectivo' THEN monto ELSE 0 END), 0) AS retiros_efectivo,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' AND COALESCE(medio_pago, 'efectivo') = 'transferencia' THEN monto ELSE 0 END), 0) AS retiros_transferencia
    FROM caja_movimientos
    WHERE caja_sesion_id = $1
    `,
    [cajaSesionId]
  );

  const m = movimientosResult.rows[0] || {};
  const apertura = n2(caja.monto_inicial);
  const ventasEfectivo = n2(m.ventas_efectivo);
  const ventasTransferencia = n2(m.ventas_transferencia);
  const ventasCuentaCorriente = n2(m.ventas_cuenta_corriente);
  const ventasDebito = n2(m.ventas_debito);
  const ventasCredito = n2(m.ventas_credito);
  const ingresosManuales = n2(m.ingresos_manuales);
  const ingresosEfectivo = n2(m.ingresos_efectivo);
  const ingresosTransferencia = n2(m.ingresos_transferencia);
  const retiros = n2(m.retiros);
  const retirosEfectivo = n2(m.retiros_efectivo);
  const retirosTransferencia = n2(m.retiros_transferencia);

  const cajaEsperada = n2(
    apertura +
    ventasEfectivo +
    ingresosEfectivo -
    retirosEfectivo
  );

  const transferenciaEsperada = n2(
    ventasTransferencia +
    ingresosTransferencia -
    retirosTransferencia
  );

  const efectivoReal = caja.estado === "cerrada" ? n2(caja.efectivo_real) : 0;
  const transferenciaReal = caja.estado === "cerrada" ? n2(caja.transferencia_real) : 0;

  const diferencia = caja.estado === "cerrada" ? n2(efectivoReal - cajaEsperada) : null;
  const diferenciaTransferencia = caja.estado === "cerrada"
    ? n2(transferenciaReal - transferenciaEsperada)
    : null;

  return {
    caja,
    resumen: {
      apertura,
      ventas_efectivo: ventasEfectivo,
      ventas_transferencia: ventasTransferencia,
      ventas_cuenta_corriente: ventasCuentaCorriente,
      ventas_debito: ventasDebito,
      ventas_credito: ventasCredito,
      ingresos_manuales: ingresosManuales,
      ingresos_efectivo: ingresosEfectivo,
      ingresos_transferencia: ingresosTransferencia,
      retiros,
      retiros_efectivo: retirosEfectivo,
      retiros_transferencia: retirosTransferencia,
      caja_esperada: cajaEsperada,
      transferencia_esperada: transferenciaEsperada,
      efectivo_real: efectivoReal,
      transferencia_real: transferenciaReal,
      diferencia,
      diferencia_transferencia: diferenciaTransferencia,
      estado_diferencia: diferencia === null ? "abierta" : diferencia > 0 ? "sobrante" : diferencia < 0 ? "faltante" : "exacta"
    }
  };
}

function permisosDesdeBody(body = {}) {
  return {
    puede_inicio: body.puede_inicio === true,
    puede_ventas: body.puede_ventas === true,
    puede_productos: body.puede_productos === true,
    puede_compras: body.puede_compras === true,
    puede_caja: body.puede_caja === true,
    puede_reportes: body.puede_reportes === true,
    puede_configuracion: body.puede_configuracion === true,
    puede_recetas: body.puede_recetas === true
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "almacen.html"));
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, mensaje: "Servidor y base funcionando" });
  } catch (error) {
    console.error("Error health:", error);
    res.status(500).json({ ok: false, error: "Error de conexión con la base de datos" });
  }
});

app.post("/api/actividad", async (req, res) => {
  try {
    const { empleado_id } = req.body || {};
    await registrarActividadEmpleado(pool, empleado_id);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error actividad:", error);
    res.status(500).json({ error: "Error al registrar actividad" });
  }
});



// Función puente para evitar error en Configuración.
// La pantalla usa mostrarPagina("configuracion") y llamaba a cargarConfiguracion().
async function cargarConfiguracion() {
  try {
    if (typeof cargarEmpleados === "function") await cargarEmpleados();
    if (typeof cargarProveedores === "function") await cargarProveedores();
    if (typeof cargarClientes === "function") await cargarClientes();
  } catch (error) {
    console.error("Error cargarConfiguracion:", error);
  }
}

// ==========================================
// LOGIN
// ==========================================
app.post("/api/login", async (req, res) => {
  try {
    const { usuario, password } = req.body;

    if (vacio(usuario) || vacio(password)) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        nombre,
        usuario,
        rol,
        activo,
        puede_inicio,
        puede_ventas,
        puede_productos,
        puede_compras,
        puede_recetas,
        puede_caja,
        puede_reportes,
        puede_configuracion
      FROM empleados
      WHERE usuario = $1
        AND password = $2
        AND activo = true
      LIMIT 1
      `,
      [String(usuario).trim(), String(password).trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    await registrarActividadEmpleado(pool, result.rows[0].id);
    result.rows[0].ultima_actividad = new Date().toISOString();

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error login:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});


// ==========================================
// EMPLEADOS / CONFIGURACION
// ==========================================
app.get("/api/empleados", async (req, res) => {
  try {
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_actividad TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS puede_recetas BOOLEAN DEFAULT false`).catch(() => {});

    const result = await pool.query(`
      SELECT *
      FROM empleados
      ORDER BY COALESCE(nombre, usuario, id::text) ASC
    `);

    const filas = result.rows.map(e => ({
      id: e.id,
      nombre: e.nombre || '',
      usuario: e.usuario || '',
      password: e.password || '',
      rol: e.rol || '',
      activo: e.activo === false ? false : true,
      puede_inicio: e.puede_inicio === true,
      puede_ventas: e.puede_ventas === true,
      puede_productos: e.puede_productos === true,
      puede_compras: e.puede_compras === true,
      puede_recetas: e.puede_recetas === true,
      puede_caja: e.puede_caja === true,
      puede_reportes: e.puede_reportes === true,
      puede_configuracion: e.puede_configuracion === true,
      ultima_actividad: e.ultima_actividad || null,
      created_at: e.created_at || null
    }));

    res.json(filas);
  } catch (error) {
    console.error("Error empleados:", error);
    res.status(500).json({ error: "Error al obtener empleados", detalle: error.message });
  }
});

app.get("/api/empleados/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        id,
        nombre,
        usuario,
        password,
        rol,
        activo,
        puede_inicio,
        puede_ventas,
        puede_productos,
        puede_compras,
        puede_recetas,
        puede_caja,
        puede_reportes,
        puede_configuracion,
        ultima_actividad,
        created_at
      FROM empleados
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error empleado por id:", error);
    res.status(500).json({ error: "Error al obtener empleado" });
  }
});

app.post("/api/empleados", async (req, res) => {
  try {
    const { nombre, usuario, password, rol, activo } = req.body;
    const permisos = permisosDesdeBody(req.body);

    if (vacio(nombre) || vacio(usuario) || vacio(password)) {
      return res.status(400).json({ error: "Nombre, usuario y contraseña son obligatorios" });
    }

    const result = await pool.query(
      `
      INSERT INTO empleados (
        nombre,
        usuario,
        password,
        rol,
        activo,
        puede_inicio,
        puede_ventas,
        puede_productos,
        puede_compras,
        puede_recetas,
        puede_caja,
        puede_reportes,
        puede_configuracion
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING
        id,
        nombre,
        usuario,
        password,
        rol,
        activo,
        puede_inicio,
        puede_ventas,
        puede_productos,
        puede_compras,
        puede_recetas,
        puede_caja,
        puede_reportes,
        puede_configuracion,
        created_at
      `,
      [
        String(nombre).trim(),
        String(usuario).trim(),
        String(password).trim(),
        vacio(rol) ? "cajero" : String(rol).trim(),
        activo === false ? false : true,
        permisos.puede_inicio,
        permisos.puede_ventas,
        permisos.puede_productos,
        permisos.puede_compras,
        permisos.puede_recetas,
        permisos.puede_caja,
        permisos.puede_reportes,
        permisos.puede_configuracion
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear empleado:", error);
    res.status(500).json({ error: "Error al crear empleado" });
  }
});

app.put("/api/empleados/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, usuario, password, rol, activo } = req.body;
    const permisos = permisosDesdeBody(req.body);

    if (vacio(nombre) || vacio(usuario) || vacio(password)) {
      return res.status(400).json({ error: "Nombre, usuario y contraseña son obligatorios" });
    }

    const result = await pool.query(
      `
      UPDATE empleados
      SET
        nombre = $1,
        usuario = $2,
        password = $3,
        rol = $4,
        activo = $5,
        puede_inicio = $6,
        puede_ventas = $7,
        puede_productos = $8,
        puede_compras = $9,
        puede_recetas = $10,
        puede_caja = $11,
        puede_reportes = $12,
        puede_configuracion = $13
      WHERE id = $14
      RETURNING
        id,
        nombre,
        usuario,
        password,
        rol,
        activo,
        puede_inicio,
        puede_ventas,
        puede_productos,
        puede_compras,
        puede_recetas,
        puede_caja,
        puede_reportes,
        puede_configuracion,
        created_at
      `,
      [
        String(nombre).trim(),
        String(usuario).trim(),
        String(password).trim(),
        vacio(rol) ? "cajero" : String(rol).trim(),
        activo === false ? false : true,
        permisos.puede_inicio,
        permisos.puede_ventas,
        permisos.puede_productos,
        permisos.puede_compras,
        permisos.puede_recetas,
        permisos.puede_caja,
        permisos.puede_reportes,
        permisos.puede_configuracion,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error editar empleado:", error);
    res.status(500).json({ error: "Error al editar empleado" });
  }
});


// ==========================================
// CATEGORIAS
// ==========================================
app.get("/api/categorias", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM categorias
      WHERE activo = true
      ORDER BY nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Error categorias:", error);
    res.status(500).json({ error: "Error al obtener categorías" });
  }
});

app.post("/api/categorias", async (req, res) => {
  try {
    const { nombre } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const result = await pool.query(
      `
      INSERT INTO categorias (nombre)
      VALUES ($1)
      RETURNING *
      `,
      [String(nombre).trim()]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear categoria:", error);
    res.status(500).json({ error: "Error al crear categoría" });
  }
});


// ==========================================
// PROVEEDORES
// ==========================================
app.get("/api/proveedores", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM proveedores
      WHERE activo = true
      ORDER BY nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Error proveedores:", error);
    res.status(500).json({ error: "Error al obtener proveedores" });
  }
});

app.post("/api/proveedores", async (req, res) => {
  try {
    const { nombre, telefono, direccion, observaciones } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre del proveedor es obligatorio" });
    }

    const result = await pool.query(
      `
      INSERT INTO proveedores (nombre, telefono, direccion, observaciones)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        String(nombre).trim(),
        telefono || "",
        direccion || "",
        observaciones || ""
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear proveedor:", error);
    res.status(500).json({ error: "Error al crear proveedor" });
  }
});


app.put("/api/proveedores/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, telefono, direccion, observaciones, activo } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre del proveedor es obligatorio" });
    }

    const result = await pool.query(
      `
      UPDATE proveedores
      SET
        nombre = $1,
        telefono = $2,
        direccion = $3,
        observaciones = $4,
        activo = $5,
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
      `,
      [
        String(nombre).trim(),
        telefono || "",
        direccion || "",
        observaciones || "",
        activo === false ? false : true,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error editar proveedor:", error);
    res.status(500).json({ error: "Error al editar proveedor" });
  }
});


app.delete("/api/proveedores/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE proveedores
      SET activo = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    res.json({ ok: true, proveedor: result.rows[0] });
  } catch (error) {
    console.error("Error eliminar proveedor:", error);
    res.status(500).json({ error: "Error al eliminar proveedor" });
  }
});





// ==========================================
// IA PLU CAJERO - SOLO NOMBRE, PLU Y CODIGO
// ==========================================
function limpiarConsultaIaPlu(texto) {
  let q = String(texto || "").toLowerCase().trim();
  q = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  q = q.replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();

  const bloqueadas = [
    "precio", "precios", "stock", "costo", "costos", "ganancia", "ganancias",
    "venta", "ventas", "caja", "reporte", "reportes", "compra", "compras",
    "usuario", "usuarios", "empleado", "empleados", "configuracion", "modificar",
    "cambiar", "editar", "borrar", "eliminar", "dar de baja", "deuda", "cuenta corriente",
    "factura", "afip", "arca", "total", "recaudacion", "cierre"
  ];

  if (bloqueadas.some(p => q.includes(p))) return { autorizado: false, q: "" };

  const palabrasPermitidas = new Set([
    "plu", "codigo", "barra", "barras", "producto", "productos", "buscar", "busca",
    "buscame", "decime", "dame", "cual", "cuál", "es", "el", "la", "los", "las",
    "de", "del", "un", "una", "por", "favor", "necesito", "quiero", "saber"
  ]);

  const terminos = q.split(" ").filter(p => p && !palabrasPermitidas.has(p));
  const consulta = terminos.join(" ").trim();

  if (!consulta || consulta.length < 2) return { autorizado: false, q: "" };
  return { autorizado: true, q: consulta };
}

app.get("/api/ia-plu", async (req, res) => {
  try {
    const original = String(req.query.q || "").trim();
    const filtro = limpiarConsultaIaPlu(original);

    if (!filtro.autorizado) {
      return res.status(403).json({
        autorizado: false,
        error: "No estoy autorizado a responder esa consulta."
      });
    }

    const result = await pool.query(
      `
      SELECT
        nombre,
        COALESCE(plu, '') AS plu,
        COALESCE(codigo_barras, '') AS codigo_barras
      FROM productos
      WHERE activo = true
        AND (
          nombre ILIKE $1
          OR COALESCE(plu, '') ILIKE $1
          OR COALESCE(codigo_barras, '') ILIKE $1
        )
      ORDER BY
        CASE
          WHEN nombre ILIKE $2 THEN 0
          WHEN COALESCE(plu, '') = $3 THEN 1
          WHEN COALESCE(codigo_barras, '') = $3 THEN 2
          ELSE 3
        END,
        nombre ASC
      LIMIT 10
      `,
      [`%${filtro.q}%`, `${filtro.q}%`, filtro.q]
    );

    res.json({ autorizado: true, productos: result.rows });
  } catch (error) {
    console.error("Error IA PLU:", error);
    res.status(500).json({ autorizado: false, error: "Error al consultar IA PLU" });
  }
});

// ==========================================
// PRODUCTOS
// ==========================================
app.get("/api/productos", async (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q).trim() : "";

    let result;

    if (q) {
      result = await pool.query(
        `
        SELECT
          p.*,
          c.nombre AS categoria_nombre
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo = true
          AND (
            p.nombre ILIKE $1
            OR COALESCE(p.codigo_barras, '') ILIKE $1
            OR COALESCE(p.plu, '') ILIKE $1
          )
        ORDER BY p.nombre ASC
        `,
        [`%${q}%`]
      );
    } else {
      result = await pool.query(`
        SELECT
          p.*,
          c.nombre AS categoria_nombre
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo = true
        ORDER BY p.nombre ASC
      `);
    }

    res.json(result.rows);
  } catch (error) {
    console.error("Error productos:", error);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

app.get("/api/productos/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.*,
        c.nombre AS categoria_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error producto por id:", error);
    res.status(500).json({ error: "Error al obtener producto" });
  }
});

app.get("/api/productos/codigo/:codigo", async (req, res) => {
  try {
    const { codigo } = req.params;
    const codigoBuscado = String(codigo || "").trim();

    if (vacio(codigoBuscado)) {
      return res.status(400).json({ error: "Código obligatorio" });
    }

    // 1) Primero busca presentaciones: docena, maple, pack, etc.
    const presentacionResult = await pool.query(
      `
      SELECT
        p.*,
        c.nombre AS categoria_nombre,
        pp.id AS presentacion_id,
        pp.nombre AS presentacion_nombre,
        pp.factor AS factor_presentacion,
        pp.precio_venta AS precio_venta_presentacion,
        pp.es_compra,
        pp.es_venta,
        'presentacion' AS tipo_codigo_encontrado
      FROM producto_presentaciones pp
      INNER JOIN productos p ON p.id = pp.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = true
        AND pp.activo = true
        AND (
          pp.codigo_barras = $1
          OR pp.plu = $1
        )
      LIMIT 1
      `,
      [codigoBuscado]
    );

    if (presentacionResult.rows.length > 0) {
      const row = presentacionResult.rows[0];
      row.precio_venta = Number(row.precio_venta_presentacion || row.precio_venta || 0);
      row.factor_presentacion = Number(row.factor_presentacion || 1);
      return res.json(row);
    }

    // 2) Después busca códigos múltiples extra del producto.
    const codigoExtraResult = await pool.query(
      `
      SELECT
        p.*,
        c.nombre AS categoria_nombre,
        NULL::integer AS presentacion_id,
        NULL::varchar AS presentacion_nombre,
        1::numeric AS factor_presentacion,
        p.precio_venta AS precio_venta_presentacion,
        true AS es_compra,
        true AS es_venta,
        'codigo_extra' AS tipo_codigo_encontrado
      FROM producto_codigos pc
      INNER JOIN productos p ON p.id = pc.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = true
        AND pc.activo = true
        AND pc.codigo = $1
      LIMIT 1
      `,
      [codigoBuscado]
    );

    if (codigoExtraResult.rows.length > 0) {
      const row = codigoExtraResult.rows[0];
      row.factor_presentacion = Number(row.factor_presentacion || 1);
      return res.json(row);
    }

    // 3) Por último busca código / PLU principal del producto.
    const result = await pool.query(
      `
      SELECT
        p.*,
        c.nombre AS categoria_nombre,
        NULL::integer AS presentacion_id,
        NULL::varchar AS presentacion_nombre,
        1::numeric AS factor_presentacion,
        p.precio_venta AS precio_venta_presentacion,
        true AS es_compra,
        true AS es_venta,
        'producto' AS tipo_codigo_encontrado
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = true
        AND (p.codigo_barras = $1 OR p.plu = $1)
      LIMIT 1
      `,
      [codigoBuscado]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const row = result.rows[0];
    row.factor_presentacion = Number(row.factor_presentacion || 1);
    res.json(row);
  } catch (error) {
    console.error("Error buscar por código/plu/presentación:", error);
    res.status(500).json({ error: "Error al buscar producto" });
  }
});

app.post("/api/productos", async (req, res) => {
  try {
    const {
      codigo_barras,
      plu,
      nombre,
      categoria_id,
      tipo_venta,
      costo,
      porcentaje_ganancia,
      cantidad_bulto,
      tipo_redondeo,
      precio_venta,
      stock_actual,
      stock_minimo,
      permite_decimal
    } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : (tipo_venta === "receta" ? "receta" : "unidad");
    const tipoRedondeoFinal = ["ninguno", "50", "100"].includes(String(tipo_redondeo || "")) ? String(tipo_redondeo) : "100";
    const precioVentaFinal = calcularPrecioVenta(costo, porcentaje_ganancia, precio_venta, cantidad_bulto, tipoRedondeoFinal);

    const result = await pool.query(
      `
      INSERT INTO productos (
        codigo_barras,
        plu,
        nombre,
        categoria_id,
        tipo_venta,
        costo,
        porcentaje_ganancia,
        cantidad_bulto,
        tipo_redondeo,
        precio_venta,
        stock_actual,
        stock_minimo,
        permite_decimal
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
      `,
      [
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        n2(costo),
        n2(porcentaje_ganancia),
        n3(cantidad_bulto || 1),
        tipoRedondeoFinal,
        precioVentaFinal,
        n3(stock_actual),
        n3(stock_minimo),
        Boolean(permite_decimal)
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear producto:", error);
    res.status(500).json({ error: "Error al crear producto" });
  }
});

app.put("/api/productos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      codigo_barras,
      plu,
      nombre,
      categoria_id,
      tipo_venta,
      costo,
      porcentaje_ganancia,
      cantidad_bulto,
      tipo_redondeo,
      precio_venta,
      stock_minimo,
      permite_decimal,
      activo
    } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : (tipo_venta === "receta" ? "receta" : "unidad");
    const tipoRedondeoFinal = ["ninguno", "50", "100"].includes(String(tipo_redondeo || "")) ? String(tipo_redondeo) : "100";
    const precioVentaFinal = calcularPrecioVenta(costo, porcentaje_ganancia, precio_venta, cantidad_bulto, tipoRedondeoFinal);

    const result = await pool.query(
      `
      UPDATE productos
      SET
        codigo_barras = $1,
        plu = $2,
        nombre = $3,
        categoria_id = $4,
        tipo_venta = $5,
        costo = $6,
        porcentaje_ganancia = $7,
        cantidad_bulto = $8,
        tipo_redondeo = $9,
        precio_venta = $10,
        stock_minimo = $11,
        permite_decimal = $12,
        activo = $13,
        updated_at = NOW()
      WHERE id = $14
      RETURNING *
      `,
      [
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        n2(costo),
        n2(porcentaje_ganancia),
        n3(cantidad_bulto || 1),
        tipoRedondeoFinal,
        precioVentaFinal,
        n3(stock_minimo),
        Boolean(permite_decimal),
        activo === false ? false : true,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    await recalcularPresentacionesProducto(pool, id, precioVentaFinal);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error editar producto:", error);
    res.status(500).json({ error: "Error al editar producto" });
  }
});

// ==========================================
// PRODUCTOS PRO v2 - PRESENTACIONES / CODIGOS / STOCK
// ==========================================
app.get("/api/productos/:id/presentaciones", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM producto_presentaciones
      WHERE producto_id = $1
      ORDER BY activo DESC, factor ASC, nombre ASC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error presentaciones:", error);
    res.status(500).json({ error: "Error al obtener presentaciones" });
  }
});

app.post("/api/productos/:id/presentaciones", async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, codigo_barras, plu, factor, precio_venta, es_compra, es_venta, activo } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre de la presentación es obligatorio" });
    }

    if (Number(factor || 0) <= 0) {
      return res.status(400).json({ error: "El factor debe ser mayor a 0" });
    }

    const productoBaseResult = await pool.query("SELECT precio_venta FROM productos WHERE id = $1 LIMIT 1", [id]);
    const precioBaseProducto = n2(productoBaseResult.rows[0]?.precio_venta || 0);
    const precioPresentacionFinal = n2(precioBaseProducto * n3(factor));

    const result = await pool.query(
      `
      INSERT INTO producto_presentaciones (
        producto_id, nombre, codigo_barras, plu, factor, precio_venta, es_compra, es_venta, activo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        id,
        String(nombre).trim(),
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        n3(factor),
        precioPresentacionFinal,
        es_compra === false ? false : true,
        es_venta === false ? false : true,
        activo === false ? false : true
      ]
    );

    await pool.query(
      `
      UPDATE productos
      SET permite_presentaciones = true, updated_at = NOW()
      WHERE id = $1
      `,
      [id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear presentación:", error);
    res.status(500).json({ error: error.message || "Error al crear presentación" });
  }
});

app.put("/api/productos/:id/presentaciones/:presentacion_id", async (req, res) => {
  try {
    const { id, presentacion_id } = req.params;
    const { nombre, codigo_barras, plu, factor, precio_venta, es_compra, es_venta, activo } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre de la presentación es obligatorio" });
    }

    if (Number(factor || 0) <= 0) {
      return res.status(400).json({ error: "El factor debe ser mayor a 0" });
    }

    const productoBaseResult = await pool.query("SELECT precio_venta FROM productos WHERE id = $1 LIMIT 1", [id]);
    const precioBaseProducto = n2(productoBaseResult.rows[0]?.precio_venta || 0);
    const precioPresentacionFinal = n2(precioBaseProducto * n3(factor));

    const result = await pool.query(
      `
      UPDATE producto_presentaciones
      SET
        nombre = $1,
        codigo_barras = $2,
        plu = $3,
        factor = $4,
        precio_venta = $5,
        es_compra = $6,
        es_venta = $7,
        activo = $8,
        updated_at = NOW()
      WHERE id = $9
        AND producto_id = $10
      RETURNING *
      `,
      [
        String(nombre).trim(),
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        n3(factor),
        precioPresentacionFinal,
        es_compra === false ? false : true,
        es_venta === false ? false : true,
        activo === false ? false : true,
        presentacion_id,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Presentación no encontrada" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error editar presentación:", error);
    res.status(500).json({ error: error.message || "Error al editar presentación" });
  }
});

app.delete("/api/productos/:id/presentaciones/:presentacion_id", async (req, res) => {
  try {
    const { id, presentacion_id } = req.params;

    const result = await pool.query(
      `
      UPDATE producto_presentaciones
      SET activo = false, updated_at = NOW()
      WHERE id = $1
        AND producto_id = $2
      RETURNING *
      `,
      [presentacion_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Presentación no encontrada" });
    }

    res.json({ ok: true, presentacion: result.rows[0] });
  } catch (error) {
    console.error("Error baja presentación:", error);
    res.status(500).json({ error: "Error al dar de baja presentación" });
  }
});

app.get("/api/productos/:id/codigos", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM producto_codigos
      WHERE producto_id = $1
      ORDER BY activo DESC, codigo ASC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error códigos producto:", error);
    res.status(500).json({ error: "Error al obtener códigos" });
  }
});

app.post("/api/productos/:id/codigos", async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, tipo, descripcion, activo } = req.body;

    if (vacio(codigo)) {
      return res.status(400).json({ error: "El código es obligatorio" });
    }

    const result = await pool.query(
      `
      INSERT INTO producto_codigos (producto_id, codigo, tipo, descripcion, activo)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        id,
        String(codigo).trim(),
        vacio(tipo) ? "barra" : String(tipo).trim(),
        descripcion || "",
        activo === false ? false : true
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear código:", error);
    res.status(500).json({ error: error.message || "Error al crear código" });
  }
});

app.delete("/api/productos/:id/codigos/:codigo_id", async (req, res) => {
  try {
    const { id, codigo_id } = req.params;

    const result = await pool.query(
      `
      UPDATE producto_codigos
      SET activo = false
      WHERE id = $1
        AND producto_id = $2
      RETURNING *
      `,
      [codigo_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Código no encontrado" });
    }

    res.json({ ok: true, codigo: result.rows[0] });
  } catch (error) {
    console.error("Error baja código:", error);
    res.status(500).json({ error: "Error al dar de baja código" });
  }
});

app.post("/api/productos/:id/ajustar-stock", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { empleado_id, tipo, cantidad, motivo } = req.body;

    const cantidadNum = n3(cantidad);

    if (!["sumar", "restar", "fijar"].includes(tipo)) {
      return res.status(400).json({ error: "Tipo inválido. Usá sumar, restar o fijar." });
    }

    if (cantidadNum < 0) {
      return res.status(400).json({ error: "La cantidad no puede ser negativa" });
    }

    await client.query("BEGIN");

    const productoResult = await client.query(
      `
      SELECT *
      FROM productos
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    if (productoResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const producto = productoResult.rows[0];
    const stockAnterior = n3(producto.stock_actual);
    let stockNuevo = stockAnterior;

    if (tipo === "sumar") stockNuevo = n3(stockAnterior + cantidadNum);
    if (tipo === "restar") stockNuevo = n3(stockAnterior - cantidadNum);
    if (tipo === "fijar") stockNuevo = cantidadNum;

    if (stockNuevo < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "El ajuste dejaría el stock en negativo" });
    }

    const updateResult = await client.query(
      `
      UPDATE productos
      SET stock_actual = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [stockNuevo, id]
    );

    await client.query(
      `
      INSERT INTO stock_ajustes (
        producto_id, empleado_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [id, empleado_id || null, tipo, cantidadNum, stockAnterior, stockNuevo, motivo || ""]
    );

    await client.query(
      `
      INSERT INTO stock_movimientos (
        producto_id, tipo, cantidad, referencia_tabla, referencia_id, empleado_id, observaciones
      )
      VALUES ($1, 'ajuste', $2, 'stock_ajustes', NULL, $3, $4)
      `,
      [id, stockNuevo - stockAnterior, empleado_id || null, motivo || `Ajuste de stock: ${tipo}`]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      producto: updateResult.rows[0],
      stock_anterior: stockAnterior,
      stock_nuevo: stockNuevo
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error ajustar stock:", error);
    res.status(500).json({ error: error.message || "Error al ajustar stock" });
  } finally {
    client.release();
  }
});

app.post("/api/productos/:id/dar-baja", async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;

    const result = await pool.query(
      `
      UPDATE productos
      SET
        activo = false,
        motivo_baja = $1,
        fecha_baja = NOW(),
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [motivo || "", id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json({ ok: true, producto: result.rows[0] });
  } catch (error) {
    console.error("Error dar de baja producto:", error);
    res.status(500).json({ error: "Error al dar de baja producto" });
  }
});



// ==========================================
// COMPRAS
// ==========================================
app.get("/api/compras", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        p.nombre AS proveedor_nombre,
        e.nombre AS empleado_nombre
      FROM compras c
      LEFT JOIN proveedores p ON p.id = c.proveedor_id
      LEFT JOIN empleados e ON e.id = c.empleado_id
      ORDER BY c.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error compras:", error);
    res.status(500).json({ error: "Error al obtener compras" });
  }
});

app.post("/api/compras", async (req, res) => {
  const client = await pool.connect();

  try {
    const { proveedor_id, empleado_id, observaciones, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "La compra debe tener al menos un producto" });
    }

    await client.query("BEGIN");

    let totalCompra = 0;
    const preciosActualizados = [];

    for (const item of items) totalCompra += n2(item.subtotal);

    await registrarActividadEmpleado(client, empleado_id);

    const compraResult = await client.query(
      `
      INSERT INTO compras (proveedor_id, empleado_id, observaciones, total)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        proveedor_id || null,
        empleado_id || null,
        observaciones || "",
        n2(totalCompra)
      ]
    );

    const compra = compraResult.rows[0];

    for (const item of items) {
      const productoId = item.producto_id;
      const cantidadIngresada = n3(item.cantidad);
      const costoUnitarioIngresado = n2(item.costo_unitario);
      const subtotal = n2(item.subtotal);
      let factorPresentacion = 1;
      let presentacionNombre = "";

      if (item.presentacion_id) {
        const presentacionResult = await client.query(
          `
          SELECT *
          FROM producto_presentaciones
          WHERE id = $1
            AND producto_id = $2
            AND activo = true
          LIMIT 1
          `,
          [item.presentacion_id, productoId]
        );

        if (presentacionResult.rows.length === 0) {
          throw new Error(`Presentación ${item.presentacion_id} no encontrada`);
        }

        factorPresentacion = Number(presentacionResult.rows[0].factor || 1);
        presentacionNombre = presentacionResult.rows[0].nombre || "";
      }

      let cantidadBase = n3(cantidadIngresada * factorPresentacion);
      let costoUnitarioBase = cantidadBase > 0 ? n2(subtotal / cantidadBase) : costoUnitarioIngresado;

      const productoResult = await client.query(
        `
        SELECT *
        FROM productos
        WHERE id = $1
        LIMIT 1
        `,
        [productoId]
      );

      if (productoResult.rows.length === 0) {
        throw new Error(`Producto ${productoId} no encontrado`);
      }

      const producto = productoResult.rows[0];

      const bultoProductoCompra = item.presentacion_id ? 1 : n3(producto.cantidad_bulto || 1);
      if (bultoProductoCompra > 1) {
        cantidadBase = n3(cantidadBase * bultoProductoCompra);
        costoUnitarioBase = cantidadBase > 0 ? n2(subtotal / cantidadBase) : costoUnitarioIngresado;
      }

      const porcentajeGanancia = n2(producto.porcentaje_ganancia || 0);
      const precioVentaActual = n2(producto.precio_venta || 0);
      const costoParaVenta = costoUnitarioBase;
      const costoProductoParaGuardar = item.presentacion_id ? costoUnitarioBase : costoUnitarioIngresado;
      const tipoRedondeoCompra = producto.tipo_redondeo || "100";
      const precioSugeridoNuevo = n2(redondearPrecio(costoParaVenta * (1 + porcentajeGanancia / 100), tipoRedondeoCompra));
      const debeActualizarPrecio = precioSugeridoNuevo > precioVentaActual;

      await client.query(
        `
        INSERT INTO compras_detalle (compra_id, producto_id, cantidad, costo_unitario, subtotal)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [compra.id, productoId, cantidadBase, costoUnitarioBase, subtotal]
      );

      const updateProductoCompra = await client.query(
        `
        UPDATE productos
        SET
          stock_actual = stock_actual + $1,
          costo = $2,
          precio_venta = CASE
            WHEN $3 > precio_venta THEN $3
            ELSE precio_venta
          END,
          updated_at = NOW()
        WHERE id = $4
        RETURNING precio_venta
        `,
        [cantidadBase, costoProductoParaGuardar, precioSugeridoNuevo, productoId]
      );

      await recalcularPresentacionesProducto(client, productoId, updateProductoCompra.rows[0]?.precio_venta || precioVentaActual);

      if (debeActualizarPrecio) {
        preciosActualizados.push({
          producto_id: producto.id,
          nombre: producto.nombre,
          precio_anterior: precioVentaActual,
          precio_nuevo: precioSugeridoNuevo,
          costo_nuevo: costoProductoParaGuardar,
          porcentaje_ganancia: porcentajeGanancia
        });
      }

      await client.query(
        `
        INSERT INTO stock_movimientos (
          producto_id, tipo, cantidad, referencia_tabla, referencia_id, empleado_id, observaciones
        )
        VALUES ($1, 'compra', $2, 'compras', $3, $4, $5)
        `,
        [
          productoId,
          cantidadBase,
          compra.id,
          empleado_id || null,
          presentacionNombre
            ? `${observaciones || ""} | Compra por presentación: ${cantidadIngresada} x ${presentacionNombre} (factor ${factorPresentacion})`
            : observaciones || ""
        ]
      );
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      compra_id: compra.id,
      compra,
      precios_actualizados: preciosActualizados,
      mensaje: preciosActualizados.length
        ? `Compra guardada. Se actualizaron ${preciosActualizados.length} precio(s) de venta automáticamente.`
        : "Compra guardada. No hizo falta actualizar precios de venta."
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error crear compra:", error);
    res.status(500).json({ error: error.message || "Error al guardar compra" });
  } finally {
    client.release();
  }
});


// ==========================================
// CAJA
// ==========================================
app.get("/api/caja/abierta", async (req, res) => {
  try {
    const caja = await buscarCajaAbierta(req.query.empleado_id || null);
    if (!caja) return res.json(null);

    const detalle = await calcularResumenCaja(pool, caja.id);
    res.json(detalle || { caja, resumen: null });
  } catch (error) {
    console.error("Error caja abierta:", error);
    res.status(500).json({ error: "Error al buscar caja abierta" });
  }
});

app.post("/api/caja/abrir", async (req, res) => {
  const client = await pool.connect();

  try {
    const { empleado_id, monto_inicial, observaciones } = req.body;

    if (!empleado_id) {
      return res.status(400).json({ error: "Empleado no informado" });
    }

    const cajaExistente = await client.query(
      `
      SELECT id
      FROM caja_sesiones
      WHERE estado = 'abierta'
        AND empleado_apertura_id = $1
      LIMIT 1
      `,
      [empleado_id]
    );

    if (cajaExistente.rows.length > 0) {
      return res.status(400).json({ error: "Este usuario ya tiene una caja abierta" });
    }

    await client.query("BEGIN");
    await registrarActividadEmpleado(client, empleado_id);

    const result = await client.query(
      `
      INSERT INTO caja_sesiones (empleado_apertura_id, monto_inicial, observaciones)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [empleado_id || null, n2(monto_inicial), observaciones || ""]
    );

    const caja = result.rows[0];

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, medio_pago, monto, motivo, empleado_id)
      VALUES ($1, 'apertura', 'efectivo', $2, $3, $4)
      `,
      [caja.id, n2(monto_inicial), "Apertura de caja", empleado_id || null]
    );

    await client.query("COMMIT");
    res.json(caja);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error abrir caja:", error);
    res.status(500).json({ error: "Error al abrir caja" });
  } finally {
    client.release();
  }
});

app.post("/api/caja/movimiento", async (req, res) => {
  try {
    const { caja_sesion_id, tipo, monto, motivo, empleado_id, medio_pago } = req.body;

    if (!caja_sesion_id) {
      return res.status(400).json({ error: "Caja no informada" });
    }

    if (!["ingreso", "retiro"].includes(tipo)) {
      return res.status(400).json({ error: "Tipo inválido" });
    }

    const medioPagoFinal = String(medio_pago || "efectivo").toLowerCase() === "transferencia" ? "transferencia" : "efectivo";

    await registrarActividadEmpleado(pool, empleado_id);

    const result = await pool.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, medio_pago, monto, motivo, empleado_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [caja_sesion_id, tipo, medioPagoFinal, n2(monto), motivo || "", empleado_id || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error movimiento caja:", error);
    res.status(500).json({ error: "Error al registrar movimiento de caja" });
  }
});

app.get("/api/caja/movimientos/:caja_sesion_id", async (req, res) => {
  try {
    const { caja_sesion_id } = req.params;

    const result = await pool.query(
      `
      SELECT
        cm.*,
        e.nombre AS empleado_nombre
      FROM caja_movimientos cm
      LEFT JOIN empleados e ON e.id = cm.empleado_id
      WHERE cm.caja_sesion_id = $1
      ORDER BY cm.id DESC
      `,
      [caja_sesion_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error listar movimientos caja:", error);
    res.status(500).json({ error: "Error al obtener movimientos de caja" });
  }
});

app.post("/api/caja/cerrar", async (req, res) => {
  const client = await pool.connect();

  try {
    const { caja_sesion_id, empleado_cierre_id, efectivo_real, transferencia_real, observaciones } = req.body;

    if (!caja_sesion_id) {
      return res.status(400).json({ error: "Caja no informada" });
    }

    await client.query("BEGIN");
    await registrarActividadEmpleado(client, empleado_cierre_id);

    const detalleCaja = await calcularResumenCaja(client, caja_sesion_id);

    if (!detalleCaja) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Caja no encontrada" });
    }

    if (detalleCaja.caja.estado !== "abierta") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La caja ya está cerrada" });
    }

    const resumen = detalleCaja.resumen;
    const efectivoReal = n2(efectivo_real);
    const transferenciaReal = n2(transferencia_real);
    const diferencia = n2(efectivoReal - resumen.caja_esperada);
    const diferenciaTransferencia = n2(transferenciaReal - resumen.transferencia_esperada);

    const updateResult = await client.query(
      `
      UPDATE caja_sesiones
      SET
        empleado_cierre_id = $1,
        fecha_cierre = NOW(),
        efectivo_real = $2,
        transferencia_real = $3,
        diferencia = $4,
        caja_esperada = $5,
        ventas_efectivo = $6,
        ventas_transferencia = $7,
        ventas_cuenta_corriente = $8,
        ventas_debito = $9,
        ventas_credito = $10,
        ingresos_manuales = $11,
        retiros = $12,
        ingresos_efectivo = $13,
        ingresos_transferencia = $14,
        retiros_efectivo = $15,
        retiros_transferencia = $16,
        transferencia_esperada = $17,
        diferencia_transferencia = $18,
        estado = 'cerrada',
        observaciones = COALESCE(observaciones, '') || $19
      WHERE id = $20
      RETURNING *
      `,
      [
        empleado_cierre_id || null,
        efectivoReal,
        transferenciaReal,
        diferencia,
        resumen.caja_esperada,
        resumen.ventas_efectivo,
        resumen.ventas_transferencia,
        resumen.ventas_cuenta_corriente,
        resumen.ventas_debito,
        resumen.ventas_credito,
        resumen.ingresos_manuales,
        resumen.retiros,
        resumen.ingresos_efectivo,
        resumen.ingresos_transferencia,
        resumen.retiros_efectivo,
        resumen.retiros_transferencia,
        resumen.transferencia_esperada,
        diferenciaTransferencia,
        observaciones ? ` | ${observaciones}` : "",
        caja_sesion_id
      ]
    );

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, medio_pago, monto, motivo, empleado_id)
      VALUES ($1, 'cierre', 'efectivo', $2, $3, $4)
      `,
      [caja_sesion_id, efectivoReal, "Cierre de caja", empleado_cierre_id || null]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      caja: updateResult.rows[0],
      resumen: {
        ...resumen,
        efectivo_real: efectivoReal,
        transferencia_real: transferenciaReal,
        diferencia,
        diferencia_transferencia: diferenciaTransferencia,
        estado_diferencia: diferencia > 0 ? "sobrante" : diferencia < 0 ? "faltante" : "exacta"
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error cerrar caja:", error);
    res.status(500).json({ error: "Error al cerrar caja" });
  } finally {
    client.release();
  }
});


// ==========================================
// VENTAS
// ==========================================

app.get("/api/ventas", async (req, res) => {
  try {
    const { desde, hasta, forma_pago, q } = req.query;

    const condiciones = [];
    const valores = [];
    let i = 1;

    if (desde) {
      condiciones.push(`((v.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta) {
      condiciones.push(`((v.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) <= $${i++}`);
      valores.push(hasta);
    }

    if (forma_pago) {
      condiciones.push(`v.forma_pago = $${i++}`);
      valores.push(String(forma_pago).trim().toLowerCase());
    }

    if (q) {
      condiciones.push(`(
        CAST(v.id AS TEXT) ILIKE $${i}
        OR COALESCE(e.nombre, '') ILIKE $${i}
        OR COALESCE(c.nombre, '') ILIKE $${i}
        OR COALESCE(v.observaciones, '') ILIKE $${i}
      )`);
      valores.push(`%${String(q).trim()}%`);
      i++;
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        v.*,
        e.nombre AS empleado_nombre,
        c.nombre AS cliente_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      ${where}
      ORDER BY v.id DESC
      `,
      valores
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas:", error);
    res.status(500).json({ error: "Error al obtener ventas" });
  }
});


app.get("/api/ventas/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const ventaResult = await pool.query(
      `
      SELECT
        v.*,
        e.nombre AS empleado_nombre,
        c.nombre AS cliente_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (ventaResult.rows.length === 0) {
      return res.status(404).json({ error: "Venta no encontrada" });
    }

    const detalleResult = await pool.query(
      `
      SELECT
        vd.*,
        p.nombre
      FROM ventas_detalle vd
      LEFT JOIN productos p ON p.id = vd.producto_id
      WHERE vd.venta_id = $1
      ORDER BY vd.id ASC
      `,
      [id]
    );

    res.json({
      venta: ventaResult.rows[0],
      detalle: detalleResult.rows
    });
  } catch (error) {
    console.error("Error venta detalle:", error);
    res.status(500).json({ error: "Error al obtener detalle de venta" });
  }
});


app.post("/api/ventas", async (req, res) => {
  const client = await pool.connect();

  try {
    const { empleado_id, forma_pago, observaciones, items, cliente_id } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "La venta debe tener al menos un producto" });
    }

    const formaPagoNormalizada = ["efectivo", "transferencia", "cuenta_corriente"].includes(String(forma_pago || "").toLowerCase())
      ? String(forma_pago).toLowerCase()
      : "efectivo";

    let clienteIdFinal = cliente_id || null;
    if (formaPagoNormalizada === "cuenta_corriente") {
      if (!clienteIdFinal) {
        return res.status(400).json({ error: "Para cuenta corriente tenés que seleccionar un cliente." });
      }
      const clienteResult = await client.query(
        "SELECT * FROM clientes WHERE id = $1 AND activo = true LIMIT 1",
        [clienteIdFinal]
      );
      if (clienteResult.rows.length === 0) {
        return res.status(400).json({ error: "Cliente no encontrado o inactivo." });
      }
    }

    if (!empleado_id) {
      return res.status(400).json({ error: "Empleado no informado" });
    }

    const cajaAbiertaResult = await client.query(
      `
      SELECT *
      FROM caja_sesiones
      WHERE estado = 'abierta'
        AND empleado_apertura_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [empleado_id]
    );

    const cajaAbierta = cajaAbiertaResult.rows[0] || null;

    // POS PRO: cada venta queda asociada a la caja abierta del usuario logueado.
    if (!cajaAbierta) {
      return res.status(400).json({ error: "Este usuario no tiene caja abierta. Abrí caja antes de vender." });
    }

    await client.query("BEGIN");
    await registrarActividadEmpleado(client, empleado_id);

    let totalVenta = 0;
    for (const item of items) {
      totalVenta += n2(item.subtotal);
    }

    const ventaResult = await client.query(
      `
      INSERT INTO ventas (caja_sesion_id, empleado_id, total, forma_pago, observaciones, cliente_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        cajaAbierta.id,
        empleado_id || null,
        n2(totalVenta),
        formaPagoNormalizada,
        observaciones || "",
        clienteIdFinal
      ]
    );

    const venta = ventaResult.rows[0];

    for (const item of items) {
      const productoId = item.producto_id;
      const cantidadIngresada = n3(item.cantidad);
      const precioUnitarioIngresado = n2(item.precio_unitario);
      const subtotal = n2(item.subtotal);
      let factorPresentacion = Number(item.factor_presentacion || 1);
      let presentacionNombre = item.presentacion_nombre || "";

      if (item.presentacion_id) {
        const presentacionResult = await client.query(
          `
          SELECT *
          FROM producto_presentaciones
          WHERE id = $1
            AND producto_id = $2
            AND activo = true
            AND es_venta = true
          LIMIT 1
          `,
          [item.presentacion_id, productoId]
        );

        if (presentacionResult.rows.length === 0) {
          throw new Error(`Presentación ${item.presentacion_id} no encontrada o no habilitada para venta`);
        }

        factorPresentacion = Number(presentacionResult.rows[0].factor || 1);
        presentacionNombre = presentacionResult.rows[0].nombre || "";
      }

      if (!factorPresentacion || factorPresentacion <= 0) {
        factorPresentacion = 1;
      }

      const cantidadBase = n3(cantidadIngresada * factorPresentacion);
      const precioUnitarioBase = cantidadBase > 0 ? n2(subtotal / cantidadBase) : precioUnitarioIngresado;

      const productoResult = await client.query(
        `
        SELECT *
        FROM productos
        WHERE id = $1
        FOR UPDATE
        `,
        [productoId]
      );

      if (productoResult.rows.length === 0) {
        throw new Error(`Producto ${productoId} no encontrado`);
      }

      const producto = productoResult.rows[0];

      if (Number(producto.stock_actual || 0) < cantidadBase) {
        throw new Error(`Stock insuficiente para ${producto.nombre}`);
      }

      await client.query(
        `
        INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario, subtotal)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [venta.id, productoId, cantidadBase, precioUnitarioBase, subtotal]
      );

      // Stock blindado: evita stock negativo incluso con dos cajas vendiendo al mismo tiempo.
      const stockUpdate = await client.query(
        `
        UPDATE productos
        SET
          stock_actual = stock_actual - $1,
          updated_at = NOW()
        WHERE id = $2
          AND stock_actual >= $1
        RETURNING *
        `,
        [cantidadBase, productoId]
      );

      if (stockUpdate.rows.length === 0) {
        throw new Error(`No se pudo descontar stock de ${producto.nombre}. Probable venta simultánea.`);
      }

      await client.query(
        `
        INSERT INTO stock_movimientos (
          producto_id, tipo, cantidad, referencia_tabla, referencia_id, empleado_id, observaciones
        )
        VALUES ($1, 'venta', $2, 'ventas', $3, $4, $5)
        `,
        [
          productoId,
          cantidadBase,
          venta.id,
          empleado_id || null,
          presentacionNombre
            ? `${observaciones || ""} | Venta por presentación: ${cantidadIngresada} x ${presentacionNombre} (factor ${factorPresentacion})`
            : observaciones || ""
        ]
      );
    }

    // Registra en caja todos los medios de pago, no solo efectivo.
    const tipoMovimientoCaja =
      formaPagoNormalizada === "efectivo" ? "venta_efectivo" :
      formaPagoNormalizada === "transferencia" ? "venta_transferencia" :
      formaPagoNormalizada === "cuenta_corriente" ? "venta_cuenta_corriente" :
      "venta";

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, medio_pago, monto, motivo, empleado_id, venta_id)
      VALUES ($1, $2, $7, $3, $4, $5, $6)
      `,
      [cajaAbierta.id, tipoMovimientoCaja, n2(totalVenta), `Venta ${formaPagoNormalizada}`, empleado_id || null, venta.id, formaPagoNormalizada === 'transferencia' ? 'transferencia' : 'efectivo']
    );

    if (formaPagoNormalizada === "cuenta_corriente") {
      await client.query(
        `
        INSERT INTO cuenta_corriente_movimientos (cliente_id, venta_id, tipo, monto, observaciones, empleado_id)
        VALUES ($1, $2, 'deuda', $3, $4, $5)
        `,
        [clienteIdFinal, venta.id, n2(totalVenta), observaciones || "Venta en cuenta corriente", empleado_id || null]
      );
    }

    await client.query("COMMIT");

    const respuesta = {
      ok: true,
      venta_id: venta.id,
      venta,
      forma_pago: formaPagoNormalizada,
      total: n2(totalVenta)
    };

    if (formaPagoNormalizada === "efectivo") {
      respuesta.comprobante_tipo = "comprobante_simple";
      respuesta.mensaje = "Venta guardada y lista para comprobante simple.";
    } else if (formaPagoNormalizada === "transferencia") {
      respuesta.comprobante_tipo = "factura_afip_pendiente";
      respuesta.afip_estado = "pendiente_backend";
      respuesta.mensaje = "Venta guardada. La factura AFIP real requiere integración adicional en el backend.";
    } else if (formaPagoNormalizada === "cuenta_corriente") {
      respuesta.comprobante_tipo = "cuenta_corriente";
      respuesta.mensaje = "Venta guardada en Cuenta Corriente. No afecta efectivo ni transferencia de caja.";
    } else {
      respuesta.comprobante_tipo = "registro_interno";
      respuesta.mensaje = "Venta guardada correctamente.";
    }

    res.json(respuesta);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error crear venta:", error);
    res.status(500).json({ error: error.message || "Error al guardar venta" });
  } finally {
    client.release();
  }
});


// ==========================================
// CLIENTES / CUENTA CORRIENTE
// ==========================================
app.get("/api/clientes", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) AS saldo
      FROM clientes c
      LEFT JOIN cuenta_corriente_movimientos m ON m.cliente_id = c.id
      WHERE c.activo = true
      GROUP BY c.id
      ORDER BY c.nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Error clientes:", error);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

app.post("/api/clientes", async (req, res) => {
  try {
    const { nombre, telefono, direccion, limite_credito, observaciones } = req.body;
    if (vacio(nombre)) return res.status(400).json({ error: "El nombre del cliente es obligatorio" });
    const result = await pool.query(
      `
      INSERT INTO clientes (nombre, telefono, direccion, limite_credito, observaciones)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [String(nombre).trim(), telefono || "", direccion || "", n2(limite_credito), observaciones || ""]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear cliente:", error);
    res.status(500).json({ error: "Error al crear cliente" });
  }
});

app.post("/api/clientes/:id/pagos", async (req, res) => {
  try {
    const { id } = req.params;
    const { monto, observaciones, empleado_id } = req.body;
    const montoNum = n2(monto);
    if (montoNum <= 0) return res.status(400).json({ error: "El monto del pago debe ser mayor a 0" });
    const cliente = await pool.query("SELECT * FROM clientes WHERE id=$1 AND activo=true LIMIT 1", [id]);
    if (!cliente.rows.length) return res.status(404).json({ error: "Cliente no encontrado" });
    const result = await pool.query(
      `
      INSERT INTO cuenta_corriente_movimientos (cliente_id, tipo, monto, observaciones, empleado_id)
      VALUES ($1, 'pago', $2, $3, $4)
      RETURNING *
      `,
      [id, montoNum, observaciones || "Pago cuenta corriente", empleado_id || null]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error pago cliente:", error);
    res.status(500).json({ error: "Error al registrar pago" });
  }
});

app.get("/api/clientes/:id/movimientos", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `
      SELECT m.*, v.total AS venta_total, e.nombre AS empleado_nombre
      FROM cuenta_corriente_movimientos m
      LEFT JOIN ventas v ON v.id = m.venta_id
      LEFT JOIN empleados e ON e.id = m.empleado_id
      WHERE m.cliente_id = $1
      ORDER BY m.fecha DESC, m.id DESC
      `,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error movimientos cliente:", error);
    res.status(500).json({ error: "Error al obtener movimientos" });
  }
});


// ==========================================
// REPORTES
// ==========================================
app.get("/api/reportes/resumen", async (req, res) => {
  try {
    const ventasHoy = await pool.query(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    `);

    const cantidadVentasHoy = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM ventas
      WHERE ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    `);

    const productosBajoStock = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM productos
      WHERE activo = true
        AND stock_actual <= stock_minimo
    `);

    const cajaAbierta = await buscarCajaAbierta();

    res.json({
      ventas_hoy: n2(ventasHoy.rows[0].total),
      cantidad_ventas_hoy: Number(cantidadVentasHoy.rows[0].cantidad || 0),
      productos_bajo_stock: Number(productosBajoStock.rows[0].cantidad || 0),
      caja_abierta: cajaAbierta
    });
  } catch (error) {
    console.error("Error reporte resumen:", error);
    res.status(500).json({ error: "Error al obtener resumen" });
  }
});

app.get("/api/reportes/ventas-por-producto", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.nombre,
        COALESCE(SUM(vd.cantidad), 0) AS cantidad_vendida,
        COALESCE(SUM(vd.subtotal), 0) AS total_vendido
      FROM ventas_detalle vd
      INNER JOIN productos p ON p.id = vd.producto_id
      GROUP BY p.id, p.nombre
      ORDER BY total_vendido DESC, p.nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas por producto:", error);
    res.status(500).json({ error: "Error al obtener ventas por producto" });
  }
});

app.get("/api/reportes/ventas-por-empleado", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id,
        e.nombre,
        COUNT(v.id) AS cantidad_ventas,
        COALESCE(SUM(v.total), 0) AS total_vendido
      FROM empleados e
      LEFT JOIN ventas v ON v.empleado_id = e.id
      GROUP BY e.id, e.nombre
      ORDER BY total_vendido DESC, e.nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas por empleado:", error);
    res.status(500).json({ error: "Error al obtener ventas por empleado" });
  }
});

app.get("/api/reportes/ventas-diarias", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS fecha,
        COUNT(*) AS cantidad_ventas,
        COALESCE(SUM(total), 0) AS total_vendido
      FROM ventas
      GROUP BY ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
      ORDER BY ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas diarias:", error);
    res.status(500).json({ error: "Error al obtener ventas diarias" });
  }
});

app.get("/api/reportes/stock-bajo", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        c.nombre AS categoria_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = true
        AND p.stock_actual <= p.stock_minimo
      ORDER BY p.nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error stock bajo:", error);
    res.status(500).json({ error: "Error al obtener stock bajo" });
  }
});


app.get("/api/reportes/inventario-resumen", async (req, res) => {
  try {
    const { estado, q } = req.query;
    const condiciones = ["p.activo = true"];
    const valores = [];
    let i = 1;

    if (q && String(q).trim()) {
      valores.push(`%${String(q).trim()}%`);
      condiciones.push(`(
        p.nombre ILIKE $${i}
        OR COALESCE(p.codigo_barras, '') ILIKE $${i}
        OR COALESCE(p.plu, '') ILIKE $${i}
      )`);
      i++;
    }

    if (estado === "sin") {
      condiciones.push("COALESCE(p.stock_actual, 0) <= 0");
    } else if (estado === "bajo") {
      condiciones.push("COALESCE(p.stock_actual, 0) > 0 AND COALESCE(p.stock_actual, 0) <= COALESCE(p.stock_minimo, 0)");
    } else if (estado === "ok") {
      condiciones.push("COALESCE(p.stock_actual, 0) > COALESCE(p.stock_minimo, 0)");
    }

    const where = condiciones.join(" AND ");

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.nombre,
        p.codigo_barras,
        p.plu,
        p.tipo_venta,
        COALESCE(p.costo, 0) AS costo,
        COALESCE(p.precio_venta, 0) AS precio_venta,
        COALESCE(p.porcentaje_ganancia, 0) AS porcentaje_ganancia,
        COALESCE(p.stock_actual, 0) AS stock_actual,
        COALESCE(p.stock_minimo, 0) AS stock_minimo,
        COALESCE(p.cantidad_bulto, 1) AS cantidad_bulto,
        ROUND((COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0))::numeric, 2) AS costo_unitario_real,
        ROUND((COALESCE(p.stock_actual, 0) * (COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0)))::numeric, 2) AS total_costo,
        ROUND((COALESCE(p.stock_actual, 0) * COALESCE(p.precio_venta, 0))::numeric, 2) AS total_venta,
        ROUND((COALESCE(p.stock_actual, 0) * (COALESCE(p.precio_venta, 0) - (COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0))))::numeric, 2) AS total_ganancia
      FROM productos p
      WHERE ${where}
      ORDER BY p.nombre ASC
      `,
      valores
    );

    const resumen = result.rows.reduce((acc, p) => {
      acc.productos += 1;
      acc.total_costo += Number(p.total_costo || 0);
      acc.total_venta += Number(p.total_venta || 0);
      acc.total_ganancia += Number(p.total_ganancia || 0);
      return acc;
    }, { productos: 0, total_costo: 0, total_venta: 0, total_ganancia: 0 });

    resumen.total_costo = n2(resumen.total_costo);
    resumen.total_venta = n2(resumen.total_venta);
    resumen.total_ganancia = n2(resumen.total_ganancia);

    res.json({ items: result.rows, resumen });
  } catch (error) {
    console.error("Error resumen inventario:", error);
    res.status(500).json({ error: "Error al obtener resumen de inventario" });
  }
});

app.get("/api/reportes/compras", async (req, res) => {
  try {
    const { desde, hasta, proveedor_id, producto_id, q } = req.query;

    const columnasFecha = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'compras'
        AND column_name IN ('fecha', 'created_at')
    `);

    const nombresColumnas = columnasFecha.rows.map(r => r.column_name);
    const fechaColumna = nombresColumnas.includes('fecha')
      ? 'fecha'
      : nombresColumnas.includes('created_at')
      ? 'created_at'
      : null;

    const condiciones = [];
    const valores = [];
    let i = 1;

    if (desde && fechaColumna) {
      condiciones.push(`((c.${fechaColumna} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta && fechaColumna) {
      condiciones.push(`((c.${fechaColumna} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) <= $${i++}`);
      valores.push(hasta);
    }

    if (proveedor_id) {
      condiciones.push(`c.proveedor_id = $${i++}`);
      valores.push(proveedor_id);
    }

    if (producto_id) {
      condiciones.push(`cd.producto_id = $${i++}`);
      valores.push(producto_id);
    }

    if (q) {
      condiciones.push(`(
        COALESCE(pr.nombre, '') ILIKE $${i}
        OR COALESCE(p.nombre, '') ILIKE $${i}
        OR COALESCE(c.observaciones, '') ILIKE $${i}
        OR CAST(c.id AS TEXT) ILIKE $${i}
      )`);
      valores.push(`%${String(q).trim()}%`);
      i++;
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
    const campoFecha = fechaColumna ? `c.${fechaColumna}` : `NULL::timestamp`;
    const ordenFecha = fechaColumna ? `c.${fechaColumna} DESC,` : "";

    const result = await pool.query(
      `
      SELECT
        c.id AS compra_id,
        ${campoFecha} AS fecha,
        c.total AS compra_total,
        c.observaciones,
        pr.id AS proveedor_id,
        pr.nombre AS proveedor_nombre,
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        cd.cantidad,
        cd.costo_unitario,
        cd.subtotal,
        e.nombre AS empleado_nombre
      FROM compras c
      INNER JOIN compras_detalle cd ON cd.compra_id = c.id
      LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
      LEFT JOIN productos p ON p.id = cd.producto_id
      LEFT JOIN empleados e ON e.id = c.empleado_id
      ${where}
      ORDER BY ${ordenFecha} c.id DESC, cd.id DESC
      `,
      valores
    );

    const movimientos = result.rows;
    const comprasUnicas = new Set();
    const proveedoresUnicos = new Set();
    const productosUnicos = new Set();
    let totalGastado = 0;

    movimientos.forEach(r => {
      comprasUnicas.add(r.compra_id);
      if (r.proveedor_id) proveedoresUnicos.add(r.proveedor_id);
      if (r.producto_id) productosUnicos.add(r.producto_id);
      totalGastado += Number(r.subtotal || 0);
    });

    const mapaProveedor = new Map();
    const mapaProducto = new Map();
    const mapaComparativa = new Map();

    movimientos.forEach(r => {
      const keyProv = r.proveedor_id || 'sin-proveedor';
      if (!mapaProveedor.has(keyProv)) {
        mapaProveedor.set(keyProv, {
          proveedor_id: r.proveedor_id,
          proveedor_nombre: r.proveedor_nombre || 'Sin proveedor',
          compras: new Set(),
          total_comprado: 0,
          ultimo_precio: Number(r.costo_unitario || 0),
          ultima_fecha: r.fecha || null,
          ultimo_ts: r.fecha ? new Date(r.fecha).getTime() : 0
        });
      }
      const prov = mapaProveedor.get(keyProv);
      prov.compras.add(r.compra_id);
      prov.total_comprado += Number(r.subtotal || 0);
      const provTs = r.fecha ? new Date(r.fecha).getTime() : 0;
      if (provTs >= prov.ultimo_ts) {
        prov.ultimo_ts = provTs;
        prov.ultimo_precio = Number(r.costo_unitario || 0);
        prov.ultima_fecha = r.fecha || null;
      }

      const keyProd = r.producto_id || 'sin-producto';
      if (!mapaProducto.has(keyProd)) {
        mapaProducto.set(keyProd, {
          producto_id: r.producto_id,
          producto_nombre: r.producto_nombre || '-',
          veces_comprado: 0,
          cantidad_total: 0,
          total_comprado: 0,
          ultimo_precio: Number(r.costo_unitario || 0),
          ultima_fecha: r.fecha || null,
          ultimo_ts: r.fecha ? new Date(r.fecha).getTime() : 0
        });
      }
      const prod = mapaProducto.get(keyProd);
      prod.veces_comprado += 1;
      prod.cantidad_total += Number(r.cantidad || 0);
      prod.total_comprado += Number(r.subtotal || 0);
      const prodTs = r.fecha ? new Date(r.fecha).getTime() : 0;
      if (prodTs >= prod.ultimo_ts) {
        prod.ultimo_ts = prodTs;
        prod.ultimo_precio = Number(r.costo_unitario || 0);
        prod.ultima_fecha = r.fecha || null;
      }

      if (producto_id && String(r.producto_id || '') === String(producto_id)) {
        const keyComp = r.proveedor_id || 'sin-proveedor';
        if (!mapaComparativa.has(keyComp)) {
          mapaComparativa.set(keyComp, {
            proveedor_id: r.proveedor_id,
            proveedor_nombre: r.proveedor_nombre || 'Sin proveedor',
            veces_comprado: 0,
            suma_precios: 0,
            precio_minimo: Number(r.costo_unitario || 0),
            precio_maximo: Number(r.costo_unitario || 0),
            ultimo_precio: Number(r.costo_unitario || 0),
            ultima_fecha: r.fecha || null,
            ultimo_ts: prodTs
          });
        }
        const comp = mapaComparativa.get(keyComp);
        const precio = Number(r.costo_unitario || 0);
        comp.veces_comprado += 1;
        comp.suma_precios += precio;
        comp.precio_minimo = Math.min(comp.precio_minimo, precio);
        comp.precio_maximo = Math.max(comp.precio_maximo, precio);
        if (prodTs >= comp.ultimo_ts) {
          comp.ultimo_ts = prodTs;
          comp.ultimo_precio = precio;
          comp.ultima_fecha = r.fecha || null;
        }
      }
    });

    const por_proveedor = Array.from(mapaProveedor.values())
      .map(r => ({
        proveedor_id: r.proveedor_id,
        proveedor_nombre: r.proveedor_nombre,
        cantidad_compras: r.compras.size,
        total_comprado: n2(r.total_comprado),
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => b.total_comprado - a.total_comprado);

    const por_producto = Array.from(mapaProducto.values())
      .map(r => ({
        producto_id: r.producto_id,
        producto_nombre: r.producto_nombre,
        veces_comprado: r.veces_comprado,
        cantidad_total: n3(r.cantidad_total),
        total_comprado: n2(r.total_comprado),
        precio_promedio: r.cantidad_total ? n2(r.total_comprado / r.cantidad_total) : 0,
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => b.total_comprado - a.total_comprado);

    const comparativa_producto = Array.from(mapaComparativa.values())
      .map(r => ({
        proveedor_id: r.proveedor_id,
        proveedor_nombre: r.proveedor_nombre,
        veces_comprado: r.veces_comprado,
        precio_promedio: r.veces_comprado ? n2(r.suma_precios / r.veces_comprado) : 0,
        precio_minimo: n2(r.precio_minimo),
        precio_maximo: n2(r.precio_maximo),
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => a.precio_promedio - b.precio_promedio);

    res.json({
      resumen: {
        compras_unicas: comprasUnicas.size,
        total_gastado: n2(totalGastado),
        proveedores_unicos: proveedoresUnicos.size,
        productos_unicos: productosUnicos.size
      },
      movimientos,
      por_proveedor,
      por_producto,
      comparativa_producto
    });
  } catch (error) {
    console.error("Error reporte compras:", error);
    res.status(500).json({ error: "Error al obtener reporte de compras" });
  }
});



app.get("/api/reportes/usuarios", async (req, res) => {
  try {
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_actividad TIMESTAMP`).catch(() => {});
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS puede_recetas BOOLEAN DEFAULT false`).catch(() => {});

    const empleadosResult = await pool.query(`SELECT * FROM empleados ORDER BY COALESCE(nombre, usuario, id::text) ASC`);
    const empleados = empleadosResult.rows || [];
    const activos = empleados.filter(e => e.activo !== false);
    const ahora = Date.now();

    const usuariosOnline = activos
      .filter(e => e.ultima_actividad && (ahora - new Date(e.ultima_actividad).getTime()) <= 5 * 60 * 1000)
      .map(e => ({
        id: e.id,
        nombre: e.nombre || '',
        usuario: e.usuario || '',
        rol: e.rol || '',
        ultima_actividad: e.ultima_actividad,
        segundos_sin_actividad: Math.max(Math.floor((ahora - new Date(e.ultima_actividad).getTime()) / 1000), 0)
      }));

    let cajasAbiertas = [];
    try {
      const tablaCaja = await pool.query(`SELECT to_regclass('public.caja_sesiones') AS existe`);
      if (tablaCaja.rows[0] && tablaCaja.rows[0].existe) {
        const columnas = await pool.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'caja_sesiones'
        `);
        const cols = new Set(columnas.rows.map(r => r.column_name));
        const colFecha = cols.has('fecha_apertura') ? 'fecha_apertura' : (cols.has('created_at') ? 'created_at' : null);
        const colEmpleado = cols.has('empleado_apertura_id') ? 'empleado_apertura_id' : null;
        const colEstado = cols.has('estado') ? 'estado' : null;
        if (colFecha && colEmpleado && colEstado) {
          const cajasResult = await pool.query(`
            SELECT cs.id, cs.${colFecha} AS fecha_apertura, cs.${colEstado} AS estado,
                   e.id AS empleado_id, COALESCE(e.nombre, 'Sin empleado') AS cajero_nombre,
                   COALESCE(e.usuario, '') AS cajero_usuario, COALESCE(e.rol, '') AS cajero_rol,
                   GREATEST(EXTRACT(EPOCH FROM (NOW() - cs.${colFecha}))::int, 0) AS segundos_abierta
            FROM caja_sesiones cs
            LEFT JOIN empleados e ON e.id = cs.${colEmpleado}
            WHERE cs.${colEstado} = 'abierta'
            ORDER BY cs.${colFecha} ASC
          `);
          cajasAbiertas = cajasResult.rows.map(c => ({
            ...c,
            segundos_abierta: Number(c.segundos_abierta || 0),
            caja_olvidada: Number(c.segundos_abierta || 0) >= 12 * 60 * 60
          }));
        }
      }
    } catch (errorCajas) {
      console.warn('Reporte usuarios: cajas abiertas no disponible:', errorCajas.message);
      cajasAbiertas = [];
    }

    res.json({
      resumen: {
        usuarios_registrados: empleados.length,
        usuarios_activos: activos.length,
        usuarios_en_linea: usuariosOnline.length,
        cajas_abiertas: cajasAbiertas.length
      },
      usuarios_en_linea: usuariosOnline,
      cajas_abiertas: cajasAbiertas,
      cajas_olvidadas: cajasAbiertas.filter(c => c.caja_olvidada)
    });
  } catch (error) {
    console.error("Error reporte usuarios:", error);
    res.status(500).json({ error: "Error al obtener reporte de usuarios", detalle: error.message });
  }
});

app.get("/api/reportes/cajeros", async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;

    const condiciones = ["cs.estado = 'cerrada'"];
    const valores = [];
    let i = 1;

    if (desde) {
      condiciones.push(`((cs.fecha_cierre AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta) {
      condiciones.push(`((cs.fecha_cierre AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) <= $${i++}`);
      valores.push(hasta);
    }

    if (empleado_id) {
      condiciones.push(`cs.empleado_apertura_id = $${i++}`);
      valores.push(empleado_id);
    }

    const where = `WHERE ${condiciones.join(" AND ")}`;

    const result = await pool.query(
      `
      SELECT
        cs.id,
        cs.fecha_apertura,
        cs.fecha_cierre,
        cs.monto_inicial,
        cs.caja_esperada,
        cs.ventas_efectivo,
        cs.ventas_transferencia,
        cs.ventas_cuenta_corriente,
        cs.transferencia_real,
        cs.transferencia_esperada,
        cs.diferencia_transferencia,
        cs.ingresos_efectivo,
        cs.ingresos_transferencia,
        cs.retiros_efectivo,
        cs.retiros_transferencia,
        cs.ventas_debito,
        cs.ventas_credito,
        cs.ingresos_manuales,
        cs.retiros,
        cs.efectivo_real,
        cs.diferencia,
        cs.observaciones,
        ea.id AS empleado_id,
        ea.nombre AS cajero_nombre,
        ec.nombre AS empleado_cierre_nombre
      FROM caja_sesiones cs
      LEFT JOIN empleados ea ON ea.id = cs.empleado_apertura_id
      LEFT JOIN empleados ec ON ec.id = cs.empleado_cierre_id
      ${where}
      ORDER BY cs.fecha_cierre DESC, cs.id DESC
      `,
      valores
    );

    const cierres = result.rows.map(r => {
      const totalVentas = n2(
        Number(r.ventas_efectivo || 0) +
        Number(r.ventas_transferencia || 0) +
        Number(r.ventas_debito || 0) +
        Number(r.ventas_credito || 0)
      );
      const diferencia = n2(r.diferencia);
      return {
        ...r,
        monto_inicial: n2(r.monto_inicial),
        ventas_efectivo: n2(r.ventas_efectivo),
        ventas_transferencia: n2(r.ventas_transferencia),
        ventas_cuenta_corriente: n2(r.ventas_cuenta_corriente),
        transferencia_real: n2(r.transferencia_real),
        transferencia_esperada: n2(r.transferencia_esperada),
        diferencia_transferencia: n2(r.diferencia_transferencia),
        ingresos_efectivo: n2(r.ingresos_efectivo),
        ingresos_transferencia: n2(r.ingresos_transferencia),
        retiros_efectivo: n2(r.retiros_efectivo),
        retiros_transferencia: n2(r.retiros_transferencia),
        ventas_debito: n2(r.ventas_debito),
        ventas_credito: n2(r.ventas_credito),
        total_ventas: totalVentas,
        ingresos_manuales: n2(r.ingresos_manuales),
        retiros: n2(r.retiros),
        caja_esperada: n2(r.caja_esperada),
        efectivo_real: n2(r.efectivo_real),
        diferencia,
        estado_diferencia: diferencia > 0 ? "sobrante" : diferencia < 0 ? "faltante" : "exacta"
      };
    });

    const resumen = cierres.reduce((acc, c) => {
      acc.cantidad_cierres += 1;
      acc.total_esperado = n2(acc.total_esperado + Number(c.caja_esperada || 0));
      acc.total_real = n2(acc.total_real + Number(c.efectivo_real || 0));
      acc.total_diferencia = n2(acc.total_diferencia + Number(c.diferencia || 0));
      if (Number(c.diferencia || 0) < 0) acc.total_faltantes = n2(acc.total_faltantes + Math.abs(Number(c.diferencia)));
      if (Number(c.diferencia || 0) > 0) acc.total_sobrantes = n2(acc.total_sobrantes + Number(c.diferencia));
      return acc;
    }, {
      cantidad_cierres: 0,
      total_esperado: 0,
      total_real: 0,
      total_diferencia: 0,
      total_faltantes: 0,
      total_sobrantes: 0
    });

    res.json({ resumen, cierres });
  } catch (error) {
    console.error("Error reporte cajeros:", error);
    res.status(500).json({ error: "Error al obtener reporte de cajeros" });
  }
});

app.get("/api/reportes/caja/:caja_sesion_id", async (req, res) => {
  try {
    const { caja_sesion_id } = req.params;

    const cajaResult = await pool.query(
      `
      SELECT *
      FROM caja_sesiones
      WHERE id = $1
      LIMIT 1
      `,
      [caja_sesion_id]
    );

    if (cajaResult.rows.length === 0) {
      return res.status(404).json({ error: "Caja no encontrada" });
    }

    const detalleCaja = await calcularResumenCaja(pool, caja_sesion_id);

    const movimientosResult = await pool.query(
      `
      SELECT cm.*, e.nombre AS empleado_nombre
      FROM caja_movimientos cm
      LEFT JOIN empleados e ON e.id = cm.empleado_id
      WHERE cm.caja_sesion_id = $1
      ORDER BY cm.id ASC
      `,
      [caja_sesion_id]
    );

    res.json({
      caja: detalleCaja?.caja || cajaResult.rows[0],
      resumen: detalleCaja?.resumen || {},
      movimientos: movimientosResult.rows
    });
  } catch (error) {
    console.error("Error reporte caja:", error);
    res.status(500).json({ error: "Error al obtener reporte de caja" });
  }
});

// ==========================================
// DASHBOARD INICIO PRO
// ==========================================
app.get("/api/dashboard/inicio-pro", async (req, res) => {
  try {
    const fechaLocal = "((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";

    const resumenResult = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN ${fechaLocal} = ${SQL_HOY_ARGENTINA} THEN total ELSE 0 END), 0) AS ventas_hoy,
        COALESCE(COUNT(*) FILTER (WHERE ${fechaLocal} = ${SQL_HOY_ARGENTINA}), 0) AS cantidad_ventas_hoy,
        COALESCE(SUM(CASE WHEN ${fechaLocal} >= DATE_TRUNC('month', ${SQL_HOY_ARGENTINA})::date
                           AND ${fechaLocal} < (DATE_TRUNC('month', ${SQL_HOY_ARGENTINA}) + INTERVAL '1 month')::date THEN total ELSE 0 END), 0) AS ventas_mes,
        COALESCE(SUM(CASE WHEN ${fechaLocal} = (${SQL_HOY_ARGENTINA} - INTERVAL '1 day')::date THEN total ELSE 0 END), 0) AS ventas_ayer,
        COALESCE(SUM(CASE WHEN ${fechaLocal} >= (DATE_TRUNC('month', ${SQL_HOY_ARGENTINA}) - INTERVAL '1 month')::date
                           AND ${fechaLocal} < DATE_TRUNC('month', ${SQL_HOY_ARGENTINA})::date THEN total ELSE 0 END), 0) AS ventas_mes_anterior
      FROM ventas
    `);

    const topProductosResult = await pool.query(`
      SELECT
        p.nombre,
        COALESCE(SUM(vd.cantidad), 0) AS cantidad_vendida,
        COALESCE(SUM(vd.subtotal), 0) AS total_vendido
      FROM ventas_detalle vd
      INNER JOIN productos p ON p.id = vd.producto_id
      INNER JOIN ventas v ON v.id = vd.venta_id
      WHERE ${fechaLocal} >= (${SQL_HOY_ARGENTINA} - INTERVAL '30 days')::date
      GROUP BY p.id, p.nombre
      ORDER BY total_vendido DESC, cantidad_vendida DESC, p.nombre ASC
      LIMIT 10
    `);

    const ventas7DiasResult = await pool.query(`
      SELECT
        TO_CHAR(d.dia, 'DD/MM') AS dia,
        d.dia AS fecha_real,
        COALESCE(SUM(v.total), 0) AS total
      FROM GENERATE_SERIES(
        (${SQL_HOY_ARGENTINA} - INTERVAL '6 days')::date,
        ${SQL_HOY_ARGENTINA},
        INTERVAL '1 day'
      ) d(dia)
      LEFT JOIN ventas v ON ${fechaLocal} = d.dia
      GROUP BY d.dia
      ORDER BY d.dia ASC
    `);

    const ventasFormaPagoResult = await pool.query(`
      SELECT
        COALESCE(forma_pago, 'sin_dato') AS forma_pago,
        COUNT(*) AS cantidad_ventas,
        COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE ${fechaLocal} = ${SQL_HOY_ARGENTINA}
      GROUP BY COALESCE(forma_pago, 'sin_dato')
      ORDER BY total DESC
    `);

    const ventasEmpleadoResult = await pool.query(`
      SELECT
        COALESCE(e.nombre, 'Sin empleado') AS nombre,
        COUNT(v.id) AS cantidad_ventas,
        COALESCE(SUM(v.total), 0) AS total_vendido
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE ${fechaLocal} >= (${SQL_HOY_ARGENTINA} - INTERVAL '30 days')::date
      GROUP BY e.id, e.nombre
      ORDER BY total_vendido DESC, cantidad_ventas DESC
      LIMIT 10
    `);

    const ultimasVentasResult = await pool.query(`
      SELECT
        v.id,
        v.fecha,
        v.total,
        v.forma_pago,
        e.nombre AS empleado_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      ORDER BY v.id DESC
      LIMIT 6
    `);

    const stockBajoResult = await pool.query(`
      SELECT
        nombre,
        stock_actual,
        stock_minimo
      FROM productos
      WHERE activo = true
        AND stock_actual <= stock_minimo
      ORDER BY (stock_actual - stock_minimo) ASC, nombre ASC
      LIMIT 10
    `);

    const clientesDeudoresResult = await pool.query(`
      SELECT
        c.nombre,
        c.telefono,
        COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) AS saldo
      FROM clientes c
      LEFT JOIN cuenta_corriente_movimientos m ON m.cliente_id = c.id
      WHERE c.activo = true
      GROUP BY c.id, c.nombre, c.telefono
      HAVING COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) > 0
      ORDER BY saldo DESC, c.nombre ASC
      LIMIT 10
    `);

    const deudaClientesResult = await pool.query(`
      SELECT COALESCE(SUM(saldo), 0) AS deuda_total
      FROM (
        SELECT COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) AS saldo
        FROM clientes c
        LEFT JOIN cuenta_corriente_movimientos m ON m.cliente_id = c.id
        WHERE c.activo = true
        GROUP BY c.id
      ) x
      WHERE saldo > 0
    `);

    const productosSinCodigoResult = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM productos
      WHERE activo = true
        AND (codigo_barras IS NULL OR TRIM(codigo_barras) = '')
    `);

    const productosSinPluResult = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM productos
      WHERE activo = true
        AND tipo_venta = 'peso'
        AND (plu IS NULL OR TRIM(plu) = '')
    `);

    const cajaAbierta = await buscarCajaAbierta();

    const movimientosCajaResult = cajaAbierta
      ? await pool.query(
          `
          SELECT
            tipo,
            monto,
            motivo,
            fecha
          FROM caja_movimientos
          WHERE caja_sesion_id = $1
          ORDER BY id DESC
          LIMIT 6
          `,
          [cajaAbierta.id]
        )
      : { rows: [] };

    const resumen = resumenResult.rows[0];

    const promedioTicket =
      Number(resumen.cantidad_ventas_hoy || 0) > 0
        ? Number(resumen.ventas_hoy || 0) / Number(resumen.cantidad_ventas_hoy || 0)
        : 0;

    const alertas = [];

    if (!cajaAbierta) {
      alertas.push("La caja está cerrada.");
    }

    if (stockBajoResult.rows.length > 0) {
      alertas.push(`Hay ${stockBajoResult.rows.length} productos con stock bajo o crítico.`);
    }

    if (clientesDeudoresResult.rows.length > 0) {
      alertas.push(`Hay ${clientesDeudoresResult.rows.length} clientes con deuda en cuenta corriente.`);
    }

    if (Number(productosSinCodigoResult.rows[0].cantidad || 0) > 0) {
      alertas.push(`Hay ${productosSinCodigoResult.rows[0].cantidad} productos sin código de barras.`);
    }

    if (Number(productosSinPluResult.rows[0].cantidad || 0) > 0) {
      alertas.push(`Hay ${productosSinPluResult.rows[0].cantidad} productos por peso sin PLU.`);
    }

    res.json({
      resumen: {
        ventas_hoy: Number(resumen.ventas_hoy || 0),
        cantidad_ventas_hoy: Number(resumen.cantidad_ventas_hoy || 0),
        promedio_ticket: Number(promedioTicket || 0),
        ventas_mes: Number(resumen.ventas_mes || 0),
        deuda_clientes: Number(deudaClientesResult.rows[0]?.deuda_total || 0),
        caja_abierta: cajaAbierta,
        productos_bajo_stock: stockBajoResult.rows.length
      },
      comparativo: {
        ventas_hoy: Number(resumen.ventas_hoy || 0),
        ventas_ayer: Number(resumen.ventas_ayer || 0),
        ventas_mes: Number(resumen.ventas_mes || 0),
        ventas_mes_anterior: Number(resumen.ventas_mes_anterior || 0)
      },
      ventas_7_dias: ventas7DiasResult.rows.map(r => ({
        dia: r.dia,
        total: Number(r.total || 0)
      })),
      ventas_forma_pago: ventasFormaPagoResult.rows.map(r => ({
        forma_pago: r.forma_pago,
        cantidad_ventas: Number(r.cantidad_ventas || 0),
        total: Number(r.total || 0)
      })),
      ventas_empleado: ventasEmpleadoResult.rows.map(r => ({
        nombre: r.nombre,
        cantidad_ventas: Number(r.cantidad_ventas || 0),
        total_vendido: Number(r.total_vendido || 0)
      })),
      clientes_deudores: clientesDeudoresResult.rows.map(r => ({
        nombre: r.nombre,
        telefono: r.telefono || "",
        saldo: Number(r.saldo || 0)
      })),
      top_productos: topProductosResult.rows.map(r => ({
        nombre: r.nombre,
        cantidad_vendida: Number(r.cantidad_vendida || 0),
        total_vendido: Number(r.total_vendido || 0)
      })),
      ultimas_ventas: ultimasVentasResult.rows.map(r => ({
        id: r.id,
        fecha: r.fecha,
        total: Number(r.total || 0),
        forma_pago: r.forma_pago,
        empleado_nombre: r.empleado_nombre || "-"
      })),
      movimientos_caja: movimientosCajaResult.rows.map(r => ({
        tipo: r.tipo,
        monto: Number(r.monto || 0),
        motivo: r.motivo || "",
        fecha: r.fecha
      })),
      stock_bajo: stockBajoResult.rows.map(r => ({
        nombre: r.nombre,
        stock_actual: Number(r.stock_actual || 0),
        stock_minimo: Number(r.stock_minimo || 0)
      })),
      alertas
    });
  } catch (error) {
    console.error("Error dashboard inicio pro:", error);
    res.status(500).json({ error: "Error al cargar dashboard del inicio" });
  }
});



// ==========================================
// ASISTENTE FRINE ADMIN
// ==========================================
function formatearDineroAr(valor) {
  return "$ " + Number(valor || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearCantidadAr(valor) {
  return Number(valor || 0).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function contieneAlguna(texto, palabras) {
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return palabras.some(p => t.includes(String(p).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
}

async function armarAuditoriaFrine() {
  const [stockNeg, sinPlu, sinCodigo, sinMinimo, margenBajo, cajasAbiertas, faltantes] = await Promise.all([
    pool.query(`SELECT nombre, stock_actual FROM productos WHERE activo = true AND stock_actual < 0 ORDER BY stock_actual ASC, nombre ASC LIMIT 10`),
    pool.query(`SELECT nombre FROM productos WHERE activo = true AND (plu IS NULL OR TRIM(plu) = '') ORDER BY nombre ASC LIMIT 10`),
    pool.query(`SELECT nombre FROM productos WHERE activo = true AND (codigo_barras IS NULL OR TRIM(codigo_barras) = '') ORDER BY nombre ASC LIMIT 10`),
    pool.query(`SELECT nombre FROM productos WHERE activo = true AND (stock_minimo IS NULL OR stock_minimo <= 0) ORDER BY nombre ASC LIMIT 10`),
    pool.query(`
      SELECT nombre, costo, precio_venta,
             CASE WHEN costo > 0 THEN ROUND(((precio_venta - costo) / costo * 100)::numeric, 2) ELSE 0 END AS margen
      FROM productos
      WHERE activo = true AND costo > 0 AND precio_venta > 0 AND ((precio_venta - costo) / costo * 100) < 10
      ORDER BY margen ASC, nombre ASC
      LIMIT 10
    `),
    pool.query(`
      SELECT cs.id, cs.fecha_apertura, e.nombre AS empleado_nombre
      FROM caja_sesiones cs
      LEFT JOIN empleados e ON e.id = cs.empleado_apertura_id
      WHERE cs.estado = 'abierta'
      ORDER BY cs.fecha_apertura ASC
      LIMIT 10
    `),
    pool.query(`
      SELECT cs.id, cs.fecha_cierre, e.nombre AS empleado_nombre, cs.diferencia
      FROM caja_sesiones cs
      LEFT JOIN empleados e ON e.id = cs.empleado_cierre_id
      WHERE cs.estado = 'cerrada' AND COALESCE(cs.diferencia,0) < 0
      ORDER BY cs.fecha_cierre DESC
      LIMIT 10
    `)
  ]);

  const partes = [];
  const addLista = (titulo, rows, map) => {
    if (!rows.length) return;
    partes.push(`${titulo}:`);
    rows.forEach(r => partes.push(`• ${map(r)}`));
  };

  addLista("⚠️ Stock negativo", stockNeg.rows, r => `${r.nombre}: ${formatearCantidadAr(r.stock_actual)}`);
  addLista("⚠️ Productos sin PLU", sinPlu.rows, r => r.nombre);
  addLista("⚠️ Productos sin código de barras", sinCodigo.rows, r => r.nombre);
  addLista("⚠️ Productos sin stock mínimo", sinMinimo.rows, r => r.nombre);
  addLista("⚠️ Margen menor al 10%", margenBajo.rows, r => `${r.nombre}: margen ${r.margen}% · costo ${formatearDineroAr(r.costo)} · venta ${formatearDineroAr(r.precio_venta)}`);
  addLista("⚠️ Cajas abiertas", cajasAbiertas.rows, r => `Caja #${r.id} · ${r.empleado_nombre || 'Sin empleado'}`);
  addLista("⚠️ Últimos faltantes de caja", faltantes.rows, r => `Caja #${r.id} · ${r.empleado_nombre || 'Sin empleado'} · ${formatearDineroAr(r.diferencia)}`);

  if (!partes.length) return "No encontré problemas importantes en productos, caja ni márgenes.";
  return "Encontré esto en Frine:\n\n" + partes.join("\n");
}

app.post("/api/asistente-frine", async (req, res) => {
  try {
    const pregunta = String(req.body?.pregunta || "").trim();
    if (!pregunta) return res.status(400).json({ error: "Escribí una consulta" });

    const esModificacion = contieneAlguna(pregunta, ["cambia", "cambiar", "modifica", "modificar", "borra", "borrar", "elimina", "eliminar", "cerrar caja", "abrir caja", "crear producto"]);
    if (esModificacion) return res.json({ respuesta: "No puedo modificar información. Solo puedo analizar Frine y mostrarte datos para que vos decidas." });

    if (contieneAlguna(pregunta, ["problema", "raro", "mal cargado", "audita", "auditoria", "revisa", "diagnostico", "diagnóstico"])) return res.json({ respuesta: await armarAuditoriaFrine() });

    if (contieneAlguna(pregunta, ["stock negativo", "negativo"])) {
      const r = await pool.query(`SELECT nombre, stock_actual FROM productos WHERE activo = true AND stock_actual < 0 ORDER BY stock_actual ASC, nombre ASC LIMIT 20`);
      if (!r.rows.length) return res.json({ respuesta: "No hay productos con stock negativo." });
      return res.json({ respuesta: "Productos con stock negativo:\n\n" + r.rows.map(x => `• ${x.nombre}: ${formatearCantidadAr(x.stock_actual)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["sin plu", "plu"])) {
      const r = await pool.query(`SELECT nombre FROM productos WHERE activo = true AND (plu IS NULL OR TRIM(plu) = '') ORDER BY nombre ASC LIMIT 30`);
      if (!r.rows.length) return res.json({ respuesta: "No encontré productos sin PLU." });
      return res.json({ respuesta: `Hay ${r.rows.length} productos sin PLU en esta muestra:\n\n` + r.rows.map(x => `• ${x.nombre}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["sin codigo", "sin código", "codigo de barras", "código de barras"])) {
      const r = await pool.query(`SELECT nombre FROM productos WHERE activo = true AND (codigo_barras IS NULL OR TRIM(codigo_barras) = '') ORDER BY nombre ASC LIMIT 30`);
      if (!r.rows.length) return res.json({ respuesta: "No encontré productos sin código de barras." });
      return res.json({ respuesta: `Hay ${r.rows.length} productos sin código de barras en esta muestra:\n\n` + r.rows.map(x => `• ${x.nombre}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["margen", "ganancia", "precio menor", "debajo del costo", "baja ganancia"])) {
      const r = await pool.query(`
        SELECT nombre, costo, precio_venta,
               ROUND(((precio_venta - costo) / NULLIF(costo,0) * 100)::numeric, 2) AS margen
        FROM productos
        WHERE activo = true AND costo > 0 AND precio_venta > 0 AND ((precio_venta - costo) / costo * 100) < 15
        ORDER BY margen ASC, nombre ASC
        LIMIT 20
      `);
      if (!r.rows.length) return res.json({ respuesta: "No encontré productos con margen bajo." });
      return res.json({ respuesta: "Productos con margen bajo:\n\n" + r.rows.map(x => `• ${x.nombre}: ${x.margen}% · costo ${formatearDineroAr(x.costo)} · venta ${formatearDineroAr(x.precio_venta)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["comprar", "reponer", "reposicion", "reposición", "stock bajo", "que falta", "qué falta"])) {
      const r = await pool.query(`
        SELECT nombre, stock_actual, stock_minimo
        FROM productos
        WHERE activo = true AND stock_actual <= stock_minimo
        ORDER BY (stock_actual - stock_minimo) ASC, nombre ASC
        LIMIT 25
      `);
      if (!r.rows.length) return res.json({ respuesta: "No hay productos por debajo del stock mínimo." });
      return res.json({ respuesta: "Conviene revisar reposición de estos productos:\n\n" + r.rows.map(x => `• ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)} · mínimo ${formatearCantidadAr(x.stock_minimo)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["caja abierta", "cajas abiertas", "faltante", "sobrante", "caja"])) {
      const abiertas = await pool.query(`
        SELECT cs.id, cs.fecha_apertura, e.nombre AS empleado_nombre
        FROM caja_sesiones cs LEFT JOIN empleados e ON e.id = cs.empleado_apertura_id
        WHERE cs.estado = 'abierta'
        ORDER BY cs.fecha_apertura ASC LIMIT 10
      `);
      const faltantes = await pool.query(`
        SELECT cs.id, cs.diferencia, e.nombre AS empleado_nombre
        FROM caja_sesiones cs LEFT JOIN empleados e ON e.id = cs.empleado_cierre_id
        WHERE cs.estado = 'cerrada' AND COALESCE(cs.diferencia,0) <> 0
        ORDER BY cs.fecha_cierre DESC LIMIT 10
      `);
      const partes = [];
      if (abiertas.rows.length) partes.push("Cajas abiertas:\n" + abiertas.rows.map(x => `• Caja #${x.id} · ${x.empleado_nombre || 'Sin empleado'}`).join("\n"));
      if (faltantes.rows.length) partes.push("Últimas diferencias de caja:\n" + faltantes.rows.map(x => `• Caja #${x.id} · ${x.empleado_nombre || 'Sin empleado'} · ${formatearDineroAr(x.diferencia)}`).join("\n"));
      return res.json({ respuesta: partes.length ? partes.join("\n\n") : "No encontré cajas abiertas ni diferencias recientes." });
    }

    return res.json({ respuesta: "Todavía no sé responder esa consulta. Probá con:\n\n• ¿Qué problemas ves?\n• ¿Qué tengo que comprar?\n• ¿Hay stock negativo?\n• ¿Hay productos sin PLU?\n• ¿Hay productos con margen bajo?\n• ¿Hay cajas abiertas?" });
  } catch (error) {
    console.error("Error asistente Frine:", error);
    res.status(500).json({ error: "Error al consultar el asistente" });
  }
});

// ==========================================
// FACTURA AFIP
// ==========================================

app.post("/api/facturar", async (req, res) => {
  try {

    const {
      total,
      doc_tipo,
      doc_nro
    } = req.body;

    const ultimo = await afip.ElectronicBilling.getLastVoucher(2, 11);

    const data = {
      CantReg: 1,
      PtoVta: 2,
      CbteTipo: 11,
      Concepto: 1,
      DocTipo: doc_tipo || 99,
      DocNro: doc_nro || 0,
      CbteDesde: ultimo + 1,
      CbteHasta: ultimo + 1,
      CbteFch: fechaAfipArgentina(),
      ImpTotal: Number(total),
      ImpTotConc: 0,
      ImpNeto: Number(total),
      ImpOpEx: 0,
      ImpIVA: 0,
      ImpTrib: 0,
      MonId: "PES",
      MonCotiz: 1
    };

    const respuesta = await afip.ElectronicBilling.createVoucher(data);

    res.json({
      ok: true,
      cae: respuesta.CAE,
      vencimiento: respuesta.CAEFchVto,
      comprobante: ultimo + 1
    });

  } catch (error) {

    console.error("ERROR AFIP:", error);

    const detalleAfip = error?.response?.data || error?.data || null;

    res.status(500).json({
      ok: false,
      error: error.message,
      detalle: detalleAfip
    });

  }
});


// ==========================================
// RECETAS / PRODUCCION
// ==========================================
app.get("/api/recetas/historial", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        rp.id,
        rp.fecha,
        rp.cantidad_final,
        rp.observaciones,
        pf.nombre AS producto_final_nombre,
        e.nombre AS empleado_nombre,
        COALESCE(
          json_agg(
            json_build_object(
              'producto_id', pi.id,
              'nombre', pi.nombre,
              'cantidad', rpd.cantidad
            )
            ORDER BY pi.nombre
          ) FILTER (WHERE rpd.id IS NOT NULL),
          '[]'
        ) AS insumos
      FROM recetas_producciones rp
      LEFT JOIN productos pf ON pf.id = rp.producto_final_id
      LEFT JOIN empleados e ON e.id = rp.empleado_id
      LEFT JOIN recetas_produccion_detalle rpd ON rpd.produccion_id = rp.id
      LEFT JOIN productos pi ON pi.id = rpd.producto_insumo_id
      GROUP BY rp.id, pf.nombre, e.nombre
      ORDER BY rp.id DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Error historial recetas:", error);
    res.status(500).json({ error: "Error al obtener historial de recetas" });
  }
});

app.post("/api/recetas/producir", async (req, res) => {
  const client = await pool.connect();
  try {
    const { producto_final_id, cantidad_final, empleado_id, observaciones, insumos } = req.body;
    const productoFinalId = Number(producto_final_id || 0);
    const cantidadFinal = n3(cantidad_final);
    const listaInsumos = Array.isArray(insumos) ? insumos : [];

    if (!productoFinalId) return res.status(400).json({ error: "Elegí el producto final" });
    if (!Number.isFinite(cantidadFinal) || cantidadFinal <= 0) return res.status(400).json({ error: "La cantidad a producir debe ser mayor a 0" });
    if (!listaInsumos.length) return res.status(400).json({ error: "Agregá al menos un insumo" });

    await client.query("BEGIN");

    const finalResult = await client.query("SELECT id, nombre, tipo_venta FROM productos WHERE id = $1 AND activo = true LIMIT 1", [productoFinalId]);
    if (finalResult.rows.length === 0) throw new Error("Producto final no encontrado");
    if (String(finalResult.rows[0].tipo_venta || "") !== "receta") throw new Error("El producto final debe estar creado como tipo Receta / producido");

    for (const item of listaInsumos) {
      const insumoId = Number(item.producto_id || 0);
      const cantidad = n3(item.cantidad);
      if (!insumoId || !Number.isFinite(cantidad) || cantidad <= 0) throw new Error("Hay un insumo con cantidad inválida");
      if (insumoId === productoFinalId) throw new Error("El producto final no puede ser también insumo de la misma producción");

      const stockResult = await client.query(
        "SELECT id, nombre, stock_actual FROM productos WHERE id = $1 AND activo = true FOR UPDATE",
        [insumoId]
      );
      if (stockResult.rows.length === 0) throw new Error("Insumo no encontrado");
      const prod = stockResult.rows[0];
      if (Number(prod.stock_actual || 0) < cantidad) {
        throw new Error(`Stock insuficiente de ${prod.nombre}. Stock actual: ${n3(prod.stock_actual)}, necesita: ${cantidad}`);
      }
    }

    const produccionResult = await client.query(
      `
      INSERT INTO recetas_producciones (producto_final_id, cantidad_final, empleado_id, observaciones)
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [productoFinalId, cantidadFinal, empleado_id || null, observaciones || ""]
    );

    const produccion = produccionResult.rows[0];

    for (const item of listaInsumos) {
      const insumoId = Number(item.producto_id || 0);
      const cantidad = n3(item.cantidad);
      await client.query(
        "UPDATE productos SET stock_actual = stock_actual - $1, updated_at = NOW() WHERE id = $2",
        [cantidad, insumoId]
      );
      await client.query(
        "INSERT INTO recetas_produccion_detalle (produccion_id, producto_insumo_id, cantidad) VALUES ($1,$2,$3)",
        [produccion.id, insumoId, cantidad]
      );
    }

    await client.query(
      "UPDATE productos SET stock_actual = stock_actual + $1, updated_at = NOW() WHERE id = $2",
      [cantidadFinal, productoFinalId]
    );

    await client.query("COMMIT");
    res.json({ ok: true, produccion });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error producir receta:", error);
    res.status(500).json({ error: error.message || "Error al producir receta" });
  } finally {
    client.release();
  }
});

asegurarColumnasAlmacen()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Error preparando columnas de almacén:", error);
    app.listen(PORT, () => {
      console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
    });
  });
