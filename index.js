const Afip = require("@afipsdk/afip.js");
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const crearLoginRouter = require("./routes/login");
const crearEmpleadosRouter = require("./routes/empleados");
const crearProveedoresRouter = require("./routes/proveedores");
const crearClientesRouter = require("./routes/clientes");
const crearCategoriasRouter = require("./routes/categorias");
const crearProductosRouter = require("./routes/productos");
const crearComprasRouter = require("./routes/compras");
const crearCajaRouter = require("./routes/caja");
const crearVentasRouter = require("./routes/ventas");
const crearReportesRouter = require("./routes/reportes");

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

// Módulo de autenticación
app.use("/api", crearLoginRouter({ pool, registrarActividadEmpleado }));

// Módulo de empleados / configuración
app.use("/api", crearEmpleadosRouter({ pool }));
app.use("/api", crearProveedoresRouter({ pool }));
app.use("/api", crearClientesRouter({ pool, n2, vacio }));
app.use("/api", crearCategoriasRouter({ pool, vacio }));
app.use("/api", crearProductosRouter({ pool, n2, n3, vacio, calcularPrecioVenta, recalcularPresentacionesProducto }));
app.use("/api", crearComprasRouter({ pool, n2, n3, redondearPrecio, recalcularPresentacionesProducto, registrarActividadEmpleado }));
app.use("/api", crearCajaRouter({ pool, n2, buscarCajaAbierta, calcularResumenCaja, registrarActividadEmpleado }));
app.use("/api", crearVentasRouter({ pool, n2, n3, registrarActividadEmpleado }));
app.use("/api", crearReportesRouter({ pool, n2, n3, buscarCajaAbierta, calcularResumenCaja, SQL_HOY_ARGENTINA }));

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
    CREATE TABLE IF NOT EXISTS categorias (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(255) NOT NULL UNIQUE,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE productos
    ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias(id)
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
    ALTER TABLE caja_movimientos
    ADD COLUMN IF NOT EXISTS tipo_retiro VARCHAR(40) DEFAULT 'otro',
    ADD COLUMN IF NOT EXISTS rrhh_empleado_id INTEGER
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
      COALESCE(SUM(CASE WHEN tipo = 'retiro' AND COALESCE(medio_pago, 'efectivo') = 'transferencia' THEN monto ELSE 0 END), 0) AS retiros_transferencia,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' AND tipo_retiro = 'sueldo_empleado' THEN monto ELSE 0 END), 0) AS retiros_sueldo,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' AND tipo_retiro = 'adelanto_empleado' THEN monto ELSE 0 END), 0) AS retiros_adelanto
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
  const retirosSueldo = n2(m.retiros_sueldo);
  const retirosAdelanto = n2(m.retiros_adelanto);

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
      retiros_sueldo: retirosSueldo,
      retiros_adelanto: retirosAdelanto,
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

// Módulo Categorías cargado desde routes/categorias.js


// Módulo Proveedores cargado desde routes/proveedores.js


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

// Módulo Productos cargado desde routes/productos.js

// Módulo Compras cargado desde routes/compras.js

// Módulo Caja cargado desde routes/caja.js

// Módulo Ventas cargado desde routes/ventas.js

// Módulo Clientes / Cuenta Corriente cargado desde routes/clientes.js


// Módulo Reportes cargado desde routes/reportes.js

// ==========================================
// RR.HH - Sueldos y adelantos desde caja
// ==========================================
app.get("/api/rrhh/resumen", async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;
    const params = [];
    const where = ["cm.tipo = 'retiro'", "cm.tipo_retiro IN ('sueldo_empleado', 'adelanto_empleado')"];

    if (desde) {
      params.push(desde);
      where.push(`(cm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $${params.length}::date`);
    }
    if (hasta) {
      params.push(hasta);
      where.push(`(cm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $${params.length}::date`);
    }
    if (empleado_id) {
      params.push(empleado_id);
      where.push(`COALESCE(cm.rrhh_empleado_id, cm.empleado_id) = $${params.length}`);
    }

    const whereSql = where.join(" AND ");

    const resumenResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN cm.tipo_retiro = 'sueldo_empleado' THEN cm.monto ELSE 0 END), 0) AS total_sueldos,
        COALESCE(SUM(CASE WHEN cm.tipo_retiro = 'adelanto_empleado' THEN cm.monto ELSE 0 END), 0) AS total_adelantos,
        COALESCE(SUM(cm.monto), 0) AS total_pagado,
        COUNT(*)::int AS cantidad_pagos
      FROM caja_movimientos cm
      WHERE ${whereSql}
      `,
      params
    );

    const empleadosResult = await pool.query(
      `
      SELECT
        COALESCE(cm.rrhh_empleado_id, cm.empleado_id) AS empleado_id,
        COALESCE(e.nombre, 'Sin empleado') AS empleado_nombre,
        COALESCE(e.usuario, '') AS usuario,
        COALESCE(SUM(CASE WHEN cm.tipo_retiro = 'sueldo_empleado' THEN cm.monto ELSE 0 END), 0) AS sueldos,
        COALESCE(SUM(CASE WHEN cm.tipo_retiro = 'adelanto_empleado' THEN cm.monto ELSE 0 END), 0) AS adelantos,
        COALESCE(SUM(cm.monto), 0) AS total_pagado,
        COUNT(*)::int AS cantidad_pagos
      FROM caja_movimientos cm
      LEFT JOIN empleados e ON e.id = COALESCE(cm.rrhh_empleado_id, cm.empleado_id)
      WHERE ${whereSql}
      GROUP BY COALESCE(cm.rrhh_empleado_id, cm.empleado_id), e.nombre, e.usuario
      ORDER BY total_pagado DESC, empleado_nombre ASC
      `,
      params
    );

    const movimientosResult = await pool.query(
      `
      SELECT
        cm.id,
        cm.fecha,
        cm.caja_sesion_id,
        cm.tipo_retiro,
        cm.medio_pago,
        cm.monto,
        cm.motivo,
        COALESCE(e.nombre, 'Sin empleado') AS empleado_nombre,
        COALESCE(e.usuario, '') AS usuario
      FROM caja_movimientos cm
      LEFT JOIN empleados e ON e.id = COALESCE(cm.rrhh_empleado_id, cm.empleado_id)
      WHERE ${whereSql}
      ORDER BY cm.fecha DESC, cm.id DESC
      LIMIT 500
      `,
      params
    );

    res.json({
      resumen: resumenResult.rows[0] || {},
      empleados: empleadosResult.rows,
      movimientos: movimientosResult.rows
    });
  } catch (error) {
    console.error("Error RRHH resumen:", error);
    res.status(500).json({ error: "Error al obtener RR.HH" });
  }
});

// Dashboard Inicio PRO cargado desde routes/reportes.js

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


function normalizarTextoIA(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerBusquedaIA(pregunta) {
  const original = String(pregunta || '').trim();
  const normal = normalizarTextoIA(original);
  const patrones = [
    /(?:vendi|vendí|venta|ventas|facture|facturé|compre|compré|compra|compras|stock|precio|producto|productos)\s+(?:de|del|la|el)?\s+(.+)/i,
    /(?:de|del)\s+(.+)/i
  ];

  let texto = '';
  for (const p of patrones) {
    const m = normal.match(p);
    if (m && m[1]) { texto = m[1]; break; }
  }
  if (!texto) texto = normal;

  const quitar = new Set([
    'hoy','ayer','mes','este','esta','semana','cuanto','cuanta','cuantos','cuantas','total','vendido','vendida','vendidos','vendidas',
    'vendi','vendí','ventas','venta','facture','facturé','facturado','producto','productos','stock','precio','compra','compras','compre','compré',
    'proveedor','proveedores','principal','mas','más','mejor','top','ranking','por','favor','frine','decime','dame','ver','quiero','saber'
  ]);

  const limpio = texto.split(' ').filter(w => w && !quitar.has(w)).join(' ').trim();
  return limpio || '';
}

function necesitaBusquedaProductoIA(pregunta) {
  return contieneAlguna(pregunta, [
    'vendi de', 'vendí de', 'venta de', 'ventas de', 'cuanto vendi de', 'cuánto vendí de', 'stock de', 'precio de',
    'producto', 'pan', 'coca', 'yerba', 'leche', 'azucar', 'azúcar', 'compré de', 'compre de', 'compras de'
  ]);
}

async function armarDetalleProductoIA(pregunta) {
  const q = extraerBusquedaIA(pregunta);
  if (!q || q.length < 2) return null;
  const like = `%${q}%`;

  const productoResult = await pool.query(`
    SELECT id, nombre, codigo_barras, plu, stock_actual, stock_minimo, costo, precio_venta
    FROM productos
    WHERE activo = true
      AND (
        nombre ILIKE $1
        OR COALESCE(codigo_barras,'') ILIKE $1
        OR COALESCE(plu,'') ILIKE $1
      )
    ORDER BY
      CASE WHEN nombre ILIKE $2 THEN 0 ELSE 1 END,
      nombre ASC
    LIMIT 5
  `, [like, `${q}%`]);

  const productos = productoResult.rows;
  const ids = productos.map(p => p.id);
  if (!ids.length) return { busqueda: q, productos: [], ventas_hoy: [], ventas_mes: [], compras_mes: [] };

  const [ventasHoy, ventasMes, comprasMes] = await Promise.all([
    pool.query(`
      SELECT p.id, p.nombre, COALESCE(SUM(vd.cantidad),0) AS cantidad, COALESCE(SUM(vd.subtotal),0) AS total
      FROM ventas_detalle vd
      INNER JOIN ventas v ON v.id = vd.venta_id
      LEFT JOIN productos p ON p.id = vd.producto_id
      WHERE vd.producto_id = ANY($1::int[])
        AND v.fecha::date = ${SQL_HOY_ARGENTINA}
      GROUP BY p.id, p.nombre
      ORDER BY total DESC
    `, [ids]),
    pool.query(`
      SELECT p.id, p.nombre, COALESCE(SUM(vd.cantidad),0) AS cantidad, COALESCE(SUM(vd.subtotal),0) AS total
      FROM ventas_detalle vd
      INNER JOIN ventas v ON v.id = vd.venta_id
      LEFT JOIN productos p ON p.id = vd.producto_id
      WHERE vd.producto_id = ANY($1::int[])
        AND date_trunc('month', v.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
      GROUP BY p.id, p.nombre
      ORDER BY total DESC
    `, [ids]),
    pool.query(`
      SELECT p.id, p.nombre, pr.nombre AS proveedor_nombre, COALESCE(SUM(cd.cantidad),0) AS cantidad, COALESCE(SUM(cd.subtotal),0) AS total
      FROM compras_detalle cd
      INNER JOIN compras c ON c.id = cd.compra_id
      LEFT JOIN productos p ON p.id = cd.producto_id
      LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
      WHERE cd.producto_id = ANY($1::int[])
        AND date_trunc('month', COALESCE(c.fecha, c.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
      GROUP BY p.id, p.nombre, pr.nombre
      ORDER BY total DESC
    `, [ids]).catch(() => ({ rows: [] }))
  ]);

  return {
    busqueda: q,
    productos,
    ventas_hoy: ventasHoy.rows,
    ventas_mes: ventasMes.rows,
    compras_mes: comprasMes.rows
  };
}



function detectarPeriodoAsistenteFrine(pregunta = '') {
  const q = normalizarTextoIA(pregunta);
  const hoy = fechaArgentinaISO();
  if (contieneAlguna(q, ['ayer', 'dia anterior', 'día anterior'])) {
    return { tipo: 'ayer', etiqueta: 'ayer', desdeSql: `${SQL_HOY_ARGENTINA} - INTERVAL '1 day'`, hastaSql: `${SQL_HOY_ARGENTINA}` };
  }
  if (contieneAlguna(q, ['anteayer'])) {
    return { tipo: 'anteayer', etiqueta: 'anteayer', desdeSql: `${SQL_HOY_ARGENTINA} - INTERVAL '2 day'`, hastaSql: `${SQL_HOY_ARGENTINA} - INTERVAL '1 day'` };
  }
  if (contieneAlguna(q, ['semana', 'esta semana', 'semanal'])) {
    return { tipo: 'semana', etiqueta: 'esta semana', desdeSql: `date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')`, hastaSql: `${SQL_HOY_ARGENTINA} + INTERVAL '1 day'` };
  }
  if (contieneAlguna(q, ['mes', 'este mes', 'mensual'])) {
    return { tipo: 'mes', etiqueta: 'este mes', desdeSql: `date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')`, hastaSql: `${SQL_HOY_ARGENTINA} + INTERVAL '1 day'` };
  }
  if (contieneAlguna(q, ['hoy', 'dia', 'día'])) {
    return { tipo: 'hoy', etiqueta: 'hoy', desdeSql: `${SQL_HOY_ARGENTINA}`, hastaSql: `${SQL_HOY_ARGENTINA} + INTERVAL '1 day'` };
  }

  const m = q.match(/(?:del|dia|día|fecha)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (m) {
    const yyyy = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : hoy.slice(0, 4);
    const mm = String(m[2]).padStart(2, '0');
    const dd = String(m[1]).padStart(2, '0');
    const fecha = `${yyyy}-${mm}-${dd}`;
    return { tipo: 'fecha', etiqueta: `el ${dd}/${mm}/${yyyy}`, desdeSql: `'${fecha}'::date`, hastaSql: `'${fecha}'::date + INTERVAL '1 day'` };
  }

  return null;
}

function esConsultaVentasPeriodoIA(pregunta = '') {
  const q = normalizarTextoIA(pregunta);
  return contieneAlguna(q, ['vendio', 'vendió', 'vendi', 'vendí', 'ventas', 'venta', 'facture', 'facturé', 'facturacion', 'facturación', 'recaudacion', 'recaudación'])
    && !!detectarPeriodoAsistenteFrine(pregunta);
}

async function consultarVentasPeriodoAsistenteFrine(pregunta = '') {
  const periodo = detectarPeriodoAsistenteFrine(pregunta) || detectarPeriodoAsistenteFrine('hoy');
  const desde = periodo.desdeSql;
  const hasta = periodo.hastaSql;

  const [resumen, cajeros, productos, pagos] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS cantidad_ventas,
        COALESCE(SUM(total),0) AS total_vendido,
        COALESCE(SUM(CASE WHEN forma_pago = 'efectivo' THEN total ELSE 0 END),0) AS efectivo,
        COALESCE(SUM(CASE WHEN forma_pago = 'transferencia' THEN total ELSE 0 END),0) AS transferencia,
        COALESCE(SUM(CASE WHEN forma_pago = 'cuenta_corriente' THEN total ELSE 0 END),0) AS cuenta_corriente,
        COALESCE(SUM(CASE WHEN forma_pago = 'debito' THEN total ELSE 0 END),0) AS debito,
        COALESCE(SUM(CASE WHEN forma_pago = 'credito' THEN total ELSE 0 END),0) AS credito
      FROM ventas
      WHERE (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') >= ${desde}
        AND (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') < ${hasta}
    `),
    pool.query(`
      SELECT COALESCE(e.nombre,'Sin cajero') AS cajero, COUNT(*)::int AS ventas, COALESCE(SUM(v.total),0) AS total
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE (v.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') >= ${desde}
        AND (v.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') < ${hasta}
      GROUP BY e.nombre
      ORDER BY total DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT COALESCE(p.nombre,'Producto') AS nombre, COALESCE(SUM(vd.cantidad),0) AS cantidad, COALESCE(SUM(vd.subtotal),0) AS total
      FROM ventas_detalle vd
      INNER JOIN ventas v ON v.id = vd.venta_id
      LEFT JOIN productos p ON p.id = vd.producto_id
      WHERE (v.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') >= ${desde}
        AND (v.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') < ${hasta}
      GROUP BY p.nombre
      ORDER BY total DESC
      LIMIT 10
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT COALESCE(forma_pago,'Sin forma') AS forma_pago, COUNT(*)::int AS ventas, COALESCE(SUM(total),0) AS total
      FROM ventas
      WHERE (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') >= ${desde}
        AND (fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') < ${hasta}
      GROUP BY forma_pago
      ORDER BY total DESC
    `)
  ]);

  return { periodo, resumen: resumen.rows[0] || {}, cajeros: cajeros.rows, productos: productos.rows, pagos: pagos.rows };
}

function responderVentasPeriodoAsistenteFrine(datos) {
  const r = datos.resumen || {};
  const lineas = [];
  lineas.push(`Ventas de ${datos.periodo.etiqueta}: ${r.cantidad_ventas || 0} ventas · ${formatearDineroAr(r.total_vendido)}.`);
  lineas.push(`Efectivo: ${formatearDineroAr(r.efectivo)} · Transferencia: ${formatearDineroAr(r.transferencia)} · Cuenta corriente: ${formatearDineroAr(r.cuenta_corriente)}.`);
  if (Number(r.debito || 0) > 0 || Number(r.credito || 0) > 0) lineas.push(`Débito: ${formatearDineroAr(r.debito)} · Crédito: ${formatearDineroAr(r.credito)}.`);

  if (datos.cajeros.length) {
    lineas.push('\nPor cajera/cajero:');
    datos.cajeros.forEach(x => lineas.push(`• ${x.cajero}: ${x.ventas} ventas · ${formatearDineroAr(x.total)}`));
  }

  if (datos.productos.length) {
    lineas.push('\nProductos más vendidos:');
    datos.productos.slice(0, 5).forEach(x => lineas.push(`• ${x.nombre}: ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
  }

  return lineas.join('\n');
}

async function armarContextoAsistenteFrineEtapa2(pregunta = '') {
  const detalleProducto = necesitaBusquedaProductoIA(pregunta) ? await armarDetalleProductoIA(pregunta).catch(() => null) : null;
  const ventasPeriodoDetectado = esConsultaVentasPeriodoIA(pregunta) ? await consultarVentasPeriodoAsistenteFrine(pregunta).catch(() => null) : null;

  const [ventasHoy, topProductosHoy, ventasPorCajeroHoy, stockBajo, stockNegativo, cajasAbiertas, comprasHoy, comprasMes, topProveedoresMes, topCompradosMes] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS cantidad_ventas,
        COALESCE(SUM(total),0) AS total_vendido,
        COALESCE(SUM(CASE WHEN forma_pago = 'efectivo' THEN total ELSE 0 END),0) AS efectivo,
        COALESCE(SUM(CASE WHEN forma_pago = 'transferencia' THEN total ELSE 0 END),0) AS transferencia,
        COALESCE(SUM(CASE WHEN forma_pago = 'cuenta_corriente' THEN total ELSE 0 END),0) AS cuenta_corriente
      FROM ventas
      WHERE fecha::date = ${SQL_HOY_ARGENTINA}
    `),
    pool.query(`
      SELECT p.nombre, COALESCE(SUM(vd.cantidad),0) AS cantidad, COALESCE(SUM(vd.subtotal),0) AS total
      FROM ventas_detalle vd
      INNER JOIN ventas v ON v.id = vd.venta_id
      LEFT JOIN productos p ON p.id = vd.producto_id
      WHERE v.fecha::date = ${SQL_HOY_ARGENTINA}
      GROUP BY p.nombre
      ORDER BY total DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT e.nombre AS cajero, COUNT(*)::int AS ventas, COALESCE(SUM(v.total),0) AS total
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE v.fecha::date = ${SQL_HOY_ARGENTINA}
      GROUP BY e.nombre
      ORDER BY total DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT nombre, stock_actual, stock_minimo, costo, precio_venta
      FROM productos
      WHERE activo = true AND COALESCE(stock_minimo,0) > 0 AND stock_actual <= stock_minimo
      ORDER BY (stock_actual - stock_minimo) ASC, nombre ASC
      LIMIT 25
    `),
    pool.query(`
      SELECT nombre, stock_actual
      FROM productos
      WHERE activo = true AND stock_actual < 0
      ORDER BY stock_actual ASC, nombre ASC
      LIMIT 25
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
      SELECT COUNT(DISTINCT c.id)::int AS cantidad_compras, COALESCE(SUM(cd.subtotal),0) AS total_comprado
      FROM compras c
      LEFT JOIN compras_detalle cd ON cd.compra_id = c.id
      WHERE COALESCE(c.fecha, c.created_at)::date = ${SQL_HOY_ARGENTINA}
    `).catch(() => ({ rows: [{ cantidad_compras: 0, total_comprado: 0 }] })),
    pool.query(`
      SELECT COUNT(DISTINCT c.id)::int AS cantidad_compras, COALESCE(SUM(cd.subtotal),0) AS total_comprado
      FROM compras c
      LEFT JOIN compras_detalle cd ON cd.compra_id = c.id
      WHERE date_trunc('month', COALESCE(c.fecha, c.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
    `).catch(() => ({ rows: [{ cantidad_compras: 0, total_comprado: 0 }] })),
    pool.query(`
      SELECT COALESCE(pr.nombre,'Sin proveedor') AS proveedor_nombre, COUNT(DISTINCT c.id)::int AS compras, COALESCE(SUM(cd.subtotal),0) AS total
      FROM compras c
      LEFT JOIN compras_detalle cd ON cd.compra_id = c.id
      LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
      WHERE date_trunc('month', COALESCE(c.fecha, c.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
      GROUP BY pr.nombre
      ORDER BY total DESC
      LIMIT 10
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT p.nombre, COALESCE(SUM(cd.cantidad),0) AS cantidad, COALESCE(SUM(cd.subtotal),0) AS total
      FROM compras_detalle cd
      INNER JOIN compras c ON c.id = cd.compra_id
      LEFT JOIN productos p ON p.id = cd.producto_id
      WHERE date_trunc('month', COALESCE(c.fecha, c.created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
      GROUP BY p.nombre
      ORDER BY total DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }))
  ]);

  const ventasMes = await pool.query(`
    SELECT
      COUNT(*)::int AS cantidad_ventas,
      COALESCE(SUM(total),0) AS total_vendido,
      COALESCE(SUM(CASE WHEN forma_pago = 'efectivo' THEN total ELSE 0 END),0) AS efectivo,
      COALESCE(SUM(CASE WHEN forma_pago = 'transferencia' THEN total ELSE 0 END),0) AS transferencia,
      COALESCE(SUM(CASE WHEN forma_pago = 'cuenta_corriente' THEN total ELSE 0 END),0) AS cuenta_corriente
    FROM ventas
    WHERE date_trunc('month', fecha AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')
  `).catch(() => ({ rows: [{ cantidad_ventas: 0, total_vendido: 0, efectivo: 0, transferencia: 0, cuenta_corriente: 0 }] }));

  const rentabilidadHoy = await pool.query(`
    SELECT
      p.nombre,
      COALESCE(SUM(vd.cantidad),0) AS cantidad,
      COALESCE(SUM(vd.subtotal),0) AS total_vendido,
      COALESCE(SUM((COALESCE(p.precio_venta,0) - COALESCE(p.costo,0)) * vd.cantidad),0) AS ganancia_estimada
    FROM ventas_detalle vd
    INNER JOIN ventas v ON v.id = vd.venta_id
    LEFT JOIN productos p ON p.id = vd.producto_id
    WHERE v.fecha::date = ${SQL_HOY_ARGENTINA}
    GROUP BY p.nombre
    ORDER BY ganancia_estimada DESC
    LIMIT 10
  `).catch(() => ({ rows: [] }));

  const productosSinMovimiento = await pool.query(`
    SELECT p.nombre, p.stock_actual, p.precio_venta, p.costo
    FROM productos p
    WHERE p.activo = true
      AND NOT EXISTS (
        SELECT 1
        FROM ventas_detalle vd
        INNER JOIN ventas v ON v.id = vd.venta_id
        WHERE vd.producto_id = p.id
          AND v.fecha >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires') - INTERVAL '30 days'
      )
    ORDER BY p.nombre ASC
    LIMIT 15
  `).catch(() => ({ rows: [] }));

  return {
    fecha_argentina: fechaArgentinaISO(),
    ventas_periodo_detectado: ventasPeriodoDetectado,
    ventas_hoy: ventasHoy.rows[0] || {},
    ventas_mes: ventasMes.rows[0] || {},
    rentabilidad_hoy: rentabilidadHoy.rows,
    productos_sin_movimiento: productosSinMovimiento.rows,
    top_productos_hoy: topProductosHoy.rows,
    ventas_por_cajero_hoy: ventasPorCajeroHoy.rows,
    stock_bajo: stockBajo.rows,
    stock_negativo: stockNegativo.rows,
    cajas_abiertas: cajasAbiertas.rows,
    compras_hoy: comprasHoy.rows[0] || {},
    compras_mes: comprasMes.rows[0] || {},
    top_proveedores_mes: topProveedoresMes.rows,
    top_comprados_mes: topCompradosMes.rows,
    detalle_producto: detalleProducto
  };
}

function resumenContextoAsistenteFrine(ctx) {
  const v = ctx.ventas_hoy || {};
  const ch = ctx.compras_hoy || {};
  const cm = ctx.compras_mes || {};
  const partes = [];
  partes.push(`Fecha Argentina: ${ctx.fecha_argentina}`);
  partes.push(`Ventas hoy: ${v.cantidad_ventas || 0} ventas · total ${formatearDineroAr(v.total_vendido)} · efectivo ${formatearDineroAr(v.efectivo)} · transferencia ${formatearDineroAr(v.transferencia)} · cuenta corriente ${formatearDineroAr(v.cuenta_corriente)}`);
  const vm = ctx.ventas_mes || {};
  partes.push(`Ventas del mes: ${vm.cantidad_ventas || 0} ventas · total ${formatearDineroAr(vm.total_vendido)} · efectivo ${formatearDineroAr(vm.efectivo)} · transferencia ${formatearDineroAr(vm.transferencia)} · cuenta corriente ${formatearDineroAr(vm.cuenta_corriente)}`);
  partes.push(`Compras hoy: ${ch.cantidad_compras || 0} compras · total ${formatearDineroAr(ch.total_comprado)}`);
  partes.push(`Compras del mes: ${cm.cantidad_compras || 0} compras · total ${formatearDineroAr(cm.total_comprado)}`);

  partes.push('Top productos vendidos hoy:');
  if (ctx.top_productos_hoy.length) ctx.top_productos_hoy.forEach(x => partes.push(`- ${x.nombre || 'Producto'}: cant. ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
  else partes.push('- Sin ventas de productos hoy.');

  partes.push('Ventas por cajero hoy:');
  if (ctx.ventas_por_cajero_hoy.length) ctx.ventas_por_cajero_hoy.forEach(x => partes.push(`- ${x.cajero || 'Sin cajero'}: ${x.ventas} ventas · ${formatearDineroAr(x.total)}`));
  else partes.push('- Sin ventas por cajero hoy.');

  partes.push('Top proveedores del mes por monto comprado:');
  if (ctx.top_proveedores_mes.length) ctx.top_proveedores_mes.forEach(x => partes.push(`- ${x.proveedor_nombre}: ${x.compras} compras · ${formatearDineroAr(x.total)}`));
  else partes.push('- Sin compras del mes para proveedores.');

  partes.push('Productos más comprados del mes:');
  if (ctx.top_comprados_mes.length) ctx.top_comprados_mes.forEach(x => partes.push(`- ${x.nombre || 'Producto'}: cant. ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
  else partes.push('- Sin compras de productos este mes.');

  partes.push('Stock bajo:');
  if (ctx.stock_bajo.length) ctx.stock_bajo.forEach(x => partes.push(`- ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)} · mínimo ${formatearCantidadAr(x.stock_minimo)} · costo ${formatearDineroAr(x.costo)} · venta ${formatearDineroAr(x.precio_venta)}`));
  else partes.push('- No hay productos por debajo del mínimo.');

  partes.push('Stock negativo:');
  if (ctx.stock_negativo.length) ctx.stock_negativo.forEach(x => partes.push(`- ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)}`));
  else partes.push('- No hay productos con stock negativo.');

  partes.push('Rentabilidad estimada hoy:');
  if (ctx.rentabilidad_hoy.length) ctx.rentabilidad_hoy.forEach(x => partes.push(`- ${x.nombre || 'Producto'}: cant. ${formatearCantidadAr(x.cantidad)} · vendido ${formatearDineroAr(x.total_vendido)} · ganancia estimada ${formatearDineroAr(x.ganancia_estimada)}`));
  else partes.push('- Sin ventas hoy para calcular rentabilidad.');

  partes.push('Productos sin movimiento en los últimos 30 días:');
  if (ctx.productos_sin_movimiento.length) ctx.productos_sin_movimiento.forEach(x => partes.push(`- ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)} · costo ${formatearDineroAr(x.costo)} · venta ${formatearDineroAr(x.precio_venta)}`));
  else partes.push('- No detecté productos sin movimiento en los últimos 30 días.');

  partes.push('Cajas abiertas:');
  if (ctx.cajas_abiertas.length) ctx.cajas_abiertas.forEach(x => partes.push(`- Caja #${x.id} · ${x.empleado_nombre || 'Sin empleado'}`));
  else partes.push('- No hay cajas abiertas.');

  if (ctx.detalle_producto) {
    const d = ctx.detalle_producto;
    partes.push(`Detalle buscado por producto: ${d.busqueda}`);
    if (!d.productos.length) {
      partes.push('- No encontré productos que coincidan con esa búsqueda.');
    } else {
      partes.push('Productos encontrados:');
      d.productos.forEach(p => partes.push(`- ${p.nombre}: stock ${formatearCantidadAr(p.stock_actual)} · mínimo ${formatearCantidadAr(p.stock_minimo)} · costo ${formatearDineroAr(p.costo)} · venta ${formatearDineroAr(p.precio_venta)} · PLU ${p.plu || '-'} · código ${p.codigo_barras || '-'}`));
      partes.push('Ventas de esos productos hoy:');
      if (d.ventas_hoy.length) d.ventas_hoy.forEach(x => partes.push(`- ${x.nombre}: cant. ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
      else partes.push('- Hoy no se vendieron esos productos.');
      partes.push('Ventas de esos productos este mes:');
      if (d.ventas_mes.length) d.ventas_mes.forEach(x => partes.push(`- ${x.nombre}: cant. ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
      else partes.push('- Este mes no se vendieron esos productos.');
      partes.push('Compras de esos productos este mes:');
      if (d.compras_mes.length) d.compras_mes.forEach(x => partes.push(`- ${x.nombre}: ${x.proveedor_nombre || 'Sin proveedor'} · cant. ${formatearCantidadAr(x.cantidad)} · ${formatearDineroAr(x.total)}`));
      else partes.push('- Este mes no se compraron esos productos.');
    }
  }

  return partes.join('\n');
}

async function responderConOpenAIFrine(pregunta, contextoTexto) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const respuesta = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: 'Sos el Asistente Frine dentro de un sistema de almacén/POS. Respondé en español argentino, claro y directo. Usá SOLO los datos reales del contexto. No inventes datos. Podés sugerir o indicar navegación, pero no modifiques información. Si el usuario pregunta por un producto específico, usá el bloque "Detalle buscado por producto". Si faltan datos, decilo. Siempre respondé con importes en formato argentino.'
        },
        {
          role: 'user',
          content: `Consulta del usuario: ${pregunta}\n\nDatos reales disponibles de Frine:\n${contextoTexto}`
        }
      ],
      temperature: 0.2,
      max_output_tokens: 900
    })
  });

  const data = await respuesta.json();
  if (!respuesta.ok) {
    console.error('Error OpenAI Frine:', data);
    throw new Error(data?.error?.message || 'Error de OpenAI');
  }

  return data.output_text || data?.output?.[0]?.content?.[0]?.text || null;
}


function detectarAccionAsistenteFrine(pregunta = '') {
  const q = String(pregunta || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const pideAbrir = contieneAlguna(q, ['abrir', 'abri', 'mostrame', 'mostrar', 'anda a', 'ir a', 'llevarme', 'ver ']);
  if (!pideAbrir) return null;
  if (contieneAlguna(q, ['reporte de compras', 'reportes compras', 'compras por proveedor'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'mostrarReporteCompras', nombre: 'Reporte de compras' };
  if (contieneAlguna(q, ['reporte de cajeros', 'cajeros'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'cargarReporteCajeros', nombre: 'Reporte de cajeros' };
  if (contieneAlguna(q, ['reporte de usuarios', 'usuarios en linea', 'usuarios conectados', 'cajas abiertas'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'mostrarReporteUsuarios', nombre: 'Reporte de usuarios' };
  if (contieneAlguna(q, ['inventario', 'stock bajo', 'resumen de stock'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'mostrarReporteInventario', nombre: 'Inventario' };
  if (contieneAlguna(q, ['cuenta corriente', 'clientes con deuda', 'deudas'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'mostrarReporteCuentaCorriente', nombre: 'Cuenta corriente' };
  if (contieneAlguna(q, ['ventas por producto'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'cargarReporteVentasPorProducto', nombre: 'Ventas por producto' };
  if (contieneAlguna(q, ['ventas por empleado', 'ventas por cajero'])) return { tipo: 'abrir_pagina', pagina: 'reportes', ejecutar: 'cargarReporteVentasPorEmpleado', nombre: 'Ventas por empleado' };
  if (contieneAlguna(q, ['historial ventas', 'historial de ventas'])) return { tipo: 'abrir_pagina', pagina: 'historial-ventas', nombre: 'Historial ventas' };
  if (contieneAlguna(q, ['ventas', 'vender', 'pos'])) return { tipo: 'abrir_pagina', pagina: 'ventas', nombre: 'Ventas' };
  if (contieneAlguna(q, ['productos', 'producto'])) return { tipo: 'abrir_pagina', pagina: 'productos', nombre: 'Productos' };
  if (contieneAlguna(q, ['compras', 'compra'])) return { tipo: 'abrir_pagina', pagina: 'compras', nombre: 'Compras' };
  if (contieneAlguna(q, ['recetas', 'produccion', 'producción'])) return { tipo: 'abrir_pagina', pagina: 'recetas', nombre: 'Recetas' };
  if (contieneAlguna(q, ['caja'])) return { tipo: 'abrir_pagina', pagina: 'caja', nombre: 'Caja' };
  if (contieneAlguna(q, ['proveedores'])) return { tipo: 'abrir_pagina', pagina: 'configuracion', subtab: 'proveedores', nombre: 'Proveedores' };
  if (contieneAlguna(q, ['clientes'])) return { tipo: 'abrir_pagina', pagina: 'configuracion', subtab: 'clientes', nombre: 'Clientes' };
  if (contieneAlguna(q, ['configuracion', 'configuración', 'permisos', 'empleados'])) return { tipo: 'abrir_pagina', pagina: 'configuracion', subtab: 'usuarios', nombre: 'Configuración' };
  if (contieneAlguna(q, ['inicio', 'dashboard', 'principal'])) return { tipo: 'abrir_pagina', pagina: 'inicio', nombre: 'Inicio' };
  return null;
}

app.post("/api/asistente-frine", async (req, res) => {
  try {
    const pregunta = String(req.body?.pregunta || "").trim();
    if (!pregunta) return res.status(400).json({ error: "Escribí una consulta" });

    const accion = detectarAccionAsistenteFrine(pregunta);
    if (accion) {
      return res.json({
        respuesta: `Listo, te llevo a ${accion.nombre || 'esa sección'}. No modifiqué ningún dato.`,
        accion
      });
    }

    const esModificacion = contieneAlguna(pregunta, ["cambia", "cambiar", "modifica", "modificar", "borra", "borrar", "elimina", "eliminar", "cerrar caja", "abrir caja", "crear producto", "guardar", "actualiza", "actualizar"]);
    if (esModificacion) return res.json({ respuesta: "No puedo modificar información. Solo puedo analizar Frine y mostrarte datos para que vos decidas." });

    const contexto = await armarContextoAsistenteFrineEtapa2(pregunta);
    const contextoTexto = resumenContextoAsistenteFrine(contexto);

    if (contexto.ventas_periodo_detectado && esConsultaVentasPeriodoIA(pregunta)) {
      return res.json({ respuesta: responderVentasPeriodoAsistenteFrine(contexto.ventas_periodo_detectado) });
    }

    try {
      const respuestaIA = await responderConOpenAIFrine(pregunta, contextoTexto);
      if (respuestaIA) return res.json({ respuesta: respuestaIA });
    } catch (errorIA) {
      console.error("Error IA OpenAI, uso respuesta interna:", errorIA.message);
    }

    if (contieneAlguna(pregunta, ["problema", "raro", "mal cargado", "audita", "auditoria", "revisa", "diagnostico", "diagnóstico"])) return res.json({ respuesta: await armarAuditoriaFrine() });

    if (contexto.detalle_producto && necesitaBusquedaProductoIA(pregunta)) {
      const d = contexto.detalle_producto;
      if (!d.productos.length) return res.json({ respuesta: `No encontré productos que coincidan con "${d.busqueda}".` });
      const lineas = [];
      lineas.push(`Búsqueda: ${d.busqueda}`);
      lineas.push('Productos encontrados:');
      d.productos.forEach(p => lineas.push(`• ${p.nombre}: stock ${formatearCantidadAr(p.stock_actual)} · venta ${formatearDineroAr(p.precio_venta)}`));
      if (d.ventas_hoy.length) {
        lineas.push('\nVentas de hoy:');
        d.ventas_hoy.forEach(x => lineas.push(`• ${x.nombre}: ${formatearCantidadAr(x.cantidad)} unidades · ${formatearDineroAr(x.total)}`));
      } else lineas.push('\nHoy no se vendió ese producto.');
      if (d.ventas_mes.length) {
        lineas.push('\nVentas del mes:');
        d.ventas_mes.forEach(x => lineas.push(`• ${x.nombre}: ${formatearCantidadAr(x.cantidad)} unidades · ${formatearDineroAr(x.total)}`));
      }
      return res.json({ respuesta: lineas.join('\n') });
    }

    if (contieneAlguna(pregunta, ["vendi hoy", "vendí hoy", "ventas hoy", "facture hoy", "facturé hoy", "cuanto vendi", "cuánto vendí"])) {
      const v = contexto.ventas_hoy || {};
      return res.json({ respuesta: `Hoy llevás ${v.cantidad_ventas || 0} ventas por un total de ${formatearDineroAr(v.total_vendido)}.\n\nEfectivo: ${formatearDineroAr(v.efectivo)}\nTransferencia: ${formatearDineroAr(v.transferencia)}\nCuenta corriente: ${formatearDineroAr(v.cuenta_corriente)}` });
    }


    if (contieneAlguna(pregunta, ["resumen", "resumen del negocio", "como va", "cómo va", "estado del negocio", "gerente"])) {
      const v = contexto.ventas_hoy || {};
      const vm = contexto.ventas_mes || {};
      const ch = contexto.compras_hoy || {};
      const cm = contexto.compras_mes || {};
      const lineas = [];
      lineas.push(`Resumen Frine · ${contexto.fecha_argentina}`);
      lineas.push(`• Hoy: ${v.cantidad_ventas || 0} ventas · ${formatearDineroAr(v.total_vendido)}.`);
      lineas.push(`• Mes: ${vm.cantidad_ventas || 0} ventas · ${formatearDineroAr(vm.total_vendido)}.`);
      lineas.push(`• Compras hoy: ${ch.cantidad_compras || 0} · ${formatearDineroAr(ch.total_comprado)}.`);
      lineas.push(`• Compras mes: ${cm.cantidad_compras || 0} · ${formatearDineroAr(cm.total_comprado)}.`);
      lineas.push(`• Stock bajo: ${contexto.stock_bajo.length} productos.`);
      lineas.push(`• Stock negativo: ${contexto.stock_negativo.length} productos.`);
      lineas.push(`• Cajas abiertas: ${contexto.cajas_abiertas.length}.`);
      if (contexto.top_productos_hoy.length) lineas.push(`• Más vendido hoy: ${contexto.top_productos_hoy[0].nombre || 'Producto'} · ${formatearDineroAr(contexto.top_productos_hoy[0].total)}.`);
      if (contexto.top_proveedores_mes.length) lineas.push(`• Proveedor principal del mes: ${contexto.top_proveedores_mes[0].proveedor_nombre} · ${formatearDineroAr(contexto.top_proveedores_mes[0].total)}.`);
      return res.json({ respuesta: lineas.join('\n') });
    }

    if (contieneAlguna(pregunta, ["urgencia", "urgencias", "problemas hoy", "que reviso", "qué reviso", "alertas"])) {
      const lineas = ['Urgencias detectadas:'];
      if (contexto.stock_negativo.length) lineas.push(`• Stock negativo: ${contexto.stock_negativo.length} productos. Revisá primero: ${contexto.stock_negativo.slice(0,5).map(x => x.nombre).join(', ')}.`);
      if (contexto.stock_bajo.length) lineas.push(`• Stock bajo: ${contexto.stock_bajo.length} productos. Reposición sugerida: ${contexto.stock_bajo.slice(0,5).map(x => x.nombre).join(', ')}.`);
      if (contexto.cajas_abiertas.length) lineas.push(`• Hay ${contexto.cajas_abiertas.length} caja/s abierta/s. Verificá si corresponden.`);
      if (contexto.productos_sin_movimiento.length) lineas.push(`• ${contexto.productos_sin_movimiento.length} productos sin movimiento reciente.`);
      if (lineas.length === 1) lineas.push('• No veo urgencias importantes con los datos disponibles.');
      return res.json({ respuesta: lineas.join('\n') });
    }

    if (contieneAlguna(pregunta, ["rentabilidad", "rentable", "ganancia estimada", "ganancia de hoy"])) {
      if (!contexto.rentabilidad_hoy.length) return res.json({ respuesta: "Hoy no hay ventas suficientes para estimar rentabilidad." });
      return res.json({ respuesta: "Rentabilidad estimada de hoy:\n\n" + contexto.rentabilidad_hoy.map(x => `• ${x.nombre || 'Producto'}: vendido ${formatearDineroAr(x.total_vendido)} · ganancia estimada ${formatearDineroAr(x.ganancia_estimada)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["sin movimiento", "no se vende", "no se vendio", "no se vendió", "parados"])) {
      if (!contexto.productos_sin_movimiento.length) return res.json({ respuesta: "No detecté productos sin movimiento en los últimos 30 días." });
      return res.json({ respuesta: "Productos sin movimiento en los últimos 30 días:\n\n" + contexto.productos_sin_movimiento.map(x => `• ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)} · venta ${formatearDineroAr(x.precio_venta)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["cajero", "cajeros", "quien vendio", "quién vendió"])) {
      if (!contexto.ventas_por_cajero_hoy.length) return res.json({ respuesta: "Hoy no hay ventas por cajero para mostrar." });
      return res.json({ respuesta: "Ventas por cajero hoy:\n\n" + contexto.ventas_por_cajero_hoy.map(x => `• ${x.cajero || 'Sin cajero'}: ${x.ventas} ventas · ${formatearDineroAr(x.total)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["proveedor", "proveedores", "a quien compre", "a quién compré", "principal proveedor"])) {
      if (!contexto.top_proveedores_mes.length) return res.json({ respuesta: "Este mes no encontré compras por proveedor." });
      return res.json({ respuesta: "Proveedores principales del mes:\n\n" + contexto.top_proveedores_mes.map(x => `• ${x.proveedor_nombre}: ${x.compras} compras · ${formatearDineroAr(x.total)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["compras", "compre", "compré", "comprado", "proveedor"])) {
      const ch = contexto.compras_hoy || {};
      const cm = contexto.compras_mes || {};
      return res.json({ respuesta: `Compras de hoy: ${ch.cantidad_compras || 0} compras por ${formatearDineroAr(ch.total_comprado)}.\nCompras del mes: ${cm.cantidad_compras || 0} compras por ${formatearDineroAr(cm.total_comprado)}.` });
    }

    if (contieneAlguna(pregunta, ["top", "producto", "mas vendido", "más vendido"])) {
      if (!contexto.top_productos_hoy.length) return res.json({ respuesta: "Hoy todavía no hay productos vendidos para mostrar." });
      return res.json({ respuesta: "Productos más vendidos de hoy:\n\n" + contexto.top_productos_hoy.map(x => `• ${x.nombre || 'Producto'}: ${formatearCantidadAr(x.cantidad)} unidades · ${formatearDineroAr(x.total)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["stock negativo", "negativo"])) {
      if (!contexto.stock_negativo.length) return res.json({ respuesta: "No hay productos con stock negativo." });
      return res.json({ respuesta: "Productos con stock negativo:\n\n" + contexto.stock_negativo.map(x => `• ${x.nombre}: ${formatearCantidadAr(x.stock_actual)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["comprar", "reponer", "reposicion", "reposición", "stock bajo", "que falta", "qué falta"])) {
      if (!contexto.stock_bajo.length) return res.json({ respuesta: "No hay productos por debajo del stock mínimo." });
      return res.json({ respuesta: "Conviene revisar reposición de estos productos:\n\n" + contexto.stock_bajo.map(x => `• ${x.nombre}: stock ${formatearCantidadAr(x.stock_actual)} · mínimo ${formatearCantidadAr(x.stock_minimo)} · costo ${formatearDineroAr(x.costo)} · venta ${formatearDineroAr(x.precio_venta)}`).join("\n") });
    }

    if (contieneAlguna(pregunta, ["caja abierta", "cajas abiertas", "caja"])) {
      if (!contexto.cajas_abiertas.length) return res.json({ respuesta: "No hay cajas abiertas." });
      return res.json({ respuesta: "Cajas abiertas:\n\n" + contexto.cajas_abiertas.map(x => `• Caja #${x.id} · ${x.empleado_nombre || 'Sin empleado'}`).join("\n") });
    }

    return res.json({ respuesta: `Etapa 3 activa. Podés preguntarme o pedirme abrir secciones:

• ¿Cuánto vendí hoy?
• ¿Cuánto se vendió ayer?
• ¿Cuánto vendió cada cajera ayer?
• ¿Cuánto vendí de pan?
• ¿Stock de Coca?
• ¿Qué cajero vendió más hoy?
• ¿Cuál fue mi proveedor principal del mes?
• ¿Qué productos compré más este mes?
• ¿Qué tengo que comprar?
• Dame un resumen del negocio
• ¿Qué urgencias tengo?
• Abrí reporte de compras` });
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
