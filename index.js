const Afip = require("@afipsdk/afip.js");
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

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

function redondearPrecio(valor) {
  const precio = Number(valor || 0);
  if (!Number.isFinite(precio) || precio <= 0) return 0;
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

function calcularPrecioVenta(costo, porcentajeGanancia, precioVentaInformado, cantidadBulto = 1) {
  const costoUnitario = costoUnitarioDesdeBulto(costo, cantidadBulto);
  const gananciaNum = n2(porcentajeGanancia);
  const precioInformado = n2(precioVentaInformado);

  if (precioInformado > 0) return precioInformado;
  if (costoUnitario > 0 && gananciaNum >= 0) {
    return n2(redondearPrecio(costoUnitario * (1 + gananciaNum / 100)));
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

async function buscarCajaAbierta() {
  const result = await pool.query(`
    SELECT *
    FROM caja_sesiones
    WHERE estado = 'abierta'
    ORDER BY id DESC
    LIMIT 1
  `);
  return result.rows[0] || null;
}


async function asegurarColumnasAlmacen() {
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
    ALTER TABLE caja_sesiones
    ADD COLUMN IF NOT EXISTS caja_esperada NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_efectivo NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_transferencia NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_debito NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_credito NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ingresos_manuales NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retiros NUMERIC DEFAULT 0
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
      COALESCE(SUM(CASE WHEN tipo = 'venta_debito' THEN monto ELSE 0 END), 0) AS ventas_debito,
      COALESCE(SUM(CASE WHEN tipo = 'venta_credito' THEN monto ELSE 0 END), 0) AS ventas_credito,
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos_manuales,
      COALESCE(SUM(CASE WHEN tipo = 'retiro' THEN monto ELSE 0 END), 0) AS retiros
    FROM caja_movimientos
    WHERE caja_sesion_id = $1
    `,
    [cajaSesionId]
  );

  const m = movimientosResult.rows[0] || {};
  const apertura = n2(caja.monto_inicial);
  const ventasEfectivo = n2(m.ventas_efectivo);
  const ventasTransferencia = n2(m.ventas_transferencia);
  const ventasDebito = n2(m.ventas_debito);
  const ventasCredito = n2(m.ventas_credito);
  const ingresosManuales = n2(m.ingresos_manuales);
  const retiros = n2(m.retiros);

  const cajaEsperada = n2(
    apertura +
    ventasEfectivo +
    ventasTransferencia +
    ventasDebito +
    ventasCredito +
    ingresosManuales -
    retiros
  );

  const efectivoReal = caja.estado === "cerrada" ? n2(caja.efectivo_real) : 0;
  const diferencia = caja.estado === "cerrada" ? n2(efectivoReal - cajaEsperada) : null;

  return {
    caja,
    resumen: {
      apertura,
      ventas_efectivo: ventasEfectivo,
      ventas_transferencia: ventasTransferencia,
      ventas_debito: ventasDebito,
      ventas_credito: ventasCredito,
      ingresos_manuales: ingresosManuales,
      retiros,
      caja_esperada: cajaEsperada,
      efectivo_real: efectivoReal,
      diferencia,
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
    puede_configuracion: body.puede_configuracion === true
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
    const result = await pool.query(`
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
        puede_caja,
        puede_reportes,
        puede_configuracion,
        created_at
      FROM empleados
      ORDER BY nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error empleados:", error);
    res.status(500).json({ error: "Error al obtener empleados" });
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
        puede_caja,
        puede_reportes,
        puede_configuracion,
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
        puede_caja,
        puede_reportes,
        puede_configuracion
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
        puede_caja = $10,
        puede_reportes = $11,
        puede_configuracion = $12
      WHERE id = $13
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
      precio_venta,
      stock_actual,
      stock_minimo,
      permite_decimal
    } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : "unidad";
    const precioVentaFinal = calcularPrecioVenta(costo, porcentaje_ganancia, precio_venta, cantidad_bulto);

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
        precio_venta,
        stock_actual,
        stock_minimo,
        permite_decimal
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
      precio_venta,
      stock_minimo,
      permite_decimal,
      activo
    } = req.body;

    if (vacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : "unidad";
    const precioVentaFinal = calcularPrecioVenta(costo, porcentaje_ganancia, precio_venta, cantidad_bulto);

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
        precio_venta = $9,
        stock_minimo = $10,
        permite_decimal = $11,
        activo = $12,
        updated_at = NOW()
      WHERE id = $13
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
      const precioSugeridoNuevo = n2(redondearPrecio(costoParaVenta * (1 + porcentajeGanancia / 100)));
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
    const caja = await buscarCajaAbierta();
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

    const cajaExistente = await client.query(`
      SELECT id
      FROM caja_sesiones
      WHERE estado = 'abierta'
      LIMIT 1
    `);

    if (cajaExistente.rows.length > 0) {
      return res.status(400).json({ error: "Ya hay una caja abierta" });
    }

    await client.query("BEGIN");

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
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id)
      VALUES ($1, 'apertura', $2, $3, $4)
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
    const { caja_sesion_id, tipo, monto, motivo, empleado_id } = req.body;

    if (!caja_sesion_id) {
      return res.status(400).json({ error: "Caja no informada" });
    }

    if (!["ingreso", "retiro"].includes(tipo)) {
      return res.status(400).json({ error: "Tipo inválido" });
    }

    const result = await pool.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [caja_sesion_id, tipo, n2(monto), motivo || "", empleado_id || null]
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
    const { caja_sesion_id, empleado_cierre_id, efectivo_real, observaciones } = req.body;

    if (!caja_sesion_id) {
      return res.status(400).json({ error: "Caja no informada" });
    }

    await client.query("BEGIN");

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
    const diferencia = n2(efectivoReal - resumen.caja_esperada);

    const updateResult = await client.query(
      `
      UPDATE caja_sesiones
      SET
        empleado_cierre_id = $1,
        fecha_cierre = NOW(),
        efectivo_real = $2,
        diferencia = $3,
        caja_esperada = $4,
        ventas_efectivo = $5,
        ventas_transferencia = $6,
        ventas_debito = $7,
        ventas_credito = $8,
        ingresos_manuales = $9,
        retiros = $10,
        estado = 'cerrada',
        observaciones = COALESCE(observaciones, '') || $11
      WHERE id = $12
      RETURNING *
      `,
      [
        empleado_cierre_id || null,
        efectivoReal,
        diferencia,
        resumen.caja_esperada,
        resumen.ventas_efectivo,
        resumen.ventas_transferencia,
        resumen.ventas_debito,
        resumen.ventas_credito,
        resumen.ingresos_manuales,
        resumen.retiros,
        observaciones ? ` | ${observaciones}` : "",
        caja_sesion_id
      ]
    );

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id)
      VALUES ($1, 'cierre', $2, $3, $4)
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
        diferencia,
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
      condiciones.push(`DATE(v.fecha) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta) {
      condiciones.push(`DATE(v.fecha) <= $${i++}`);
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
        e.nombre AS empleado_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
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
        e.nombre AS empleado_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
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
    const { empleado_id, forma_pago, observaciones, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "La venta debe tener al menos un producto" });
    }

    const formaPagoNormalizada = ["efectivo", "transferencia", "debito", "credito"].includes(String(forma_pago || "").toLowerCase())
      ? String(forma_pago).toLowerCase()
      : "efectivo";

    const cajaAbiertaResult = await client.query(`
      SELECT *
      FROM caja_sesiones
      WHERE estado = 'abierta'
      ORDER BY id DESC
      LIMIT 1
    `);

    const cajaAbierta = cajaAbiertaResult.rows[0] || null;

    // POS PRO: desde ahora ninguna venta se guarda sin caja abierta.
    // Aunque sea transferencia, débito o crédito, queda asociada a una caja.
    if (!cajaAbierta) {
      return res.status(400).json({ error: "No hay caja abierta. Abrí caja antes de vender." });
    }

    await client.query("BEGIN");

    let totalVenta = 0;
    for (const item of items) {
      totalVenta += n2(item.subtotal);
    }

    const ventaResult = await client.query(
      `
      INSERT INTO ventas (caja_sesion_id, empleado_id, total, forma_pago, observaciones)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        cajaAbierta.id,
        empleado_id || null,
        n2(totalVenta),
        formaPagoNormalizada,
        observaciones || ""
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
      formaPagoNormalizada === "debito" ? "venta_debito" :
      formaPagoNormalizada === "credito" ? "venta_credito" :
      "venta";

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id, venta_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [cajaAbierta.id, tipoMovimientoCaja, n2(totalVenta), `Venta ${formaPagoNormalizada}`, empleado_id || null, venta.id]
    );

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
// REPORTES
// ==========================================
app.get("/api/reportes/resumen", async (req, res) => {
  try {
    const ventasHoy = await pool.query(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE DATE(fecha) = CURRENT_DATE
    `);

    const cantidadVentasHoy = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM ventas
      WHERE DATE(fecha) = CURRENT_DATE
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
        DATE(fecha) AS fecha,
        COUNT(*) AS cantidad_ventas,
        COALESCE(SUM(total), 0) AS total_vendido
      FROM ventas
      GROUP BY DATE(fecha)
      ORDER BY DATE(fecha) DESC
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
      condiciones.push(`DATE(c.${fechaColumna}) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta && fechaColumna) {
      condiciones.push(`DATE(c.${fechaColumna}) <= $${i++}`);
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


app.get("/api/reportes/cajeros", async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;

    const condiciones = ["cs.estado = 'cerrada'"];
    const valores = [];
    let i = 1;

    if (desde) {
      condiciones.push(`DATE(cs.fecha_cierre) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta) {
      condiciones.push(`DATE(cs.fecha_cierre) <= $${i++}`);
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

    const movimientosResult = await pool.query(
      `
      SELECT *
      FROM caja_movimientos
      WHERE caja_sesion_id = $1
      ORDER BY id ASC
      `,
      [caja_sesion_id]
    );

    res.json({
      caja: cajaResult.rows[0],
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
    const resumenResult = await pool.query(`
      SELECT
        COALESCE(SUM(total), 0) AS ventas_hoy,
        COUNT(*) AS cantidad_ventas_hoy
      FROM ventas
      WHERE DATE(fecha) = CURRENT_DATE
    `);

    const topProductosResult = await pool.query(`
      SELECT
        p.nombre,
        COALESCE(SUM(vd.cantidad), 0) AS cantidad_vendida,
        COALESCE(SUM(vd.subtotal), 0) AS total_vendido
      FROM ventas_detalle vd
      INNER JOIN productos p ON p.id = vd.producto_id
      GROUP BY p.id, p.nombre
      ORDER BY total_vendido DESC
      LIMIT 5
    `);

    const ventas7DiasResult = await pool.query(`
      SELECT
        TO_CHAR(DATE(fecha), 'DD/MM') AS dia,
        DATE(fecha) AS fecha_real,
        COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE fecha >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY DATE(fecha)
      ORDER BY DATE(fecha) ASC
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
      ORDER BY nombre ASC
      LIMIT 5
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
      alertas.push(`Hay ${stockBajoResult.rows.length} productos con stock bajo.`);
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
        caja_abierta: cajaAbierta,
        productos_bajo_stock: stockBajoResult.rows.length
      },
      ventas_7_dias: ventas7DiasResult.rows.map(r => ({
        dia: r.dia,
        total: Number(r.total || 0)
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
      CbteFch: parseInt(
        new Date()
          .toISOString()
          .slice(0,10)
          .replace(/-/g, '')
      ),
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
