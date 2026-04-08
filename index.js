const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("."));

function normalizarNumero(valor, decimales = 2) {
  const num = Number(valor || 0);
  return Number(num.toFixed(decimales));
}

function esTextoVacio(valor) {
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

    if (esTextoVacio(usuario) || esTextoVacio(password)) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios" });
    }

    const result = await pool.query(
      `
      SELECT id, nombre, usuario, rol, activo
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

app.get("/api/empleados", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nombre, usuario, rol, activo, created_at
      FROM empleados
      ORDER BY nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Error empleados:", error);
    res.status(500).json({ error: "Error al obtener empleados" });
  }
});

app.post("/api/empleados", async (req, res) => {
  try {
    const { nombre, usuario, password, rol } = req.body;

    if (esTextoVacio(nombre) || esTextoVacio(usuario) || esTextoVacio(password)) {
      return res.status(400).json({ error: "Nombre, usuario y contraseña son obligatorios" });
    }

    const result = await pool.query(
      `
      INSERT INTO empleados (nombre, usuario, password, rol)
      VALUES ($1, $2, $3, $4)
      RETURNING id, nombre, usuario, rol, activo, created_at
      `,
      [
        String(nombre).trim(),
        String(usuario).trim(),
        String(password).trim(),
        esTextoVacio(rol) ? "cajero" : String(rol).trim()
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error crear empleado:", error);
    res.status(500).json({ error: "Error al crear empleado" });
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

    if (esTextoVacio(nombre)) {
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

    if (esTextoVacio(nombre)) {
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

    const result = await pool.query(
      `
      SELECT
        p.*,
        c.nombre AS categoria_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.activo = true
        AND (p.codigo_barras = $1 OR p.plu = $1)
      LIMIT 1
      `,
      [codigo]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error buscar por código/plu:", error);
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
      precio_venta,
      stock_actual,
      stock_minimo,
      permite_decimal
    } = req.body;

    if (esTextoVacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : "unidad";

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
        precio_venta,
        stock_actual,
        stock_minimo,
        permite_decimal
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        esTextoVacio(codigo_barras) ? null : String(codigo_barras).trim(),
        esTextoVacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        normalizarNumero(costo, 2),
        normalizarNumero(porcentaje_ganancia, 2),
        normalizarNumero(precio_venta, 2),
        tipo === "peso" ? normalizarNumero(stock_actual, 3) : normalizarNumero(stock_actual, 3),
        tipo === "peso" ? normalizarNumero(stock_minimo, 3) : normalizarNumero(stock_minimo, 3),
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
      precio_venta,
      stock_minimo,
      permite_decimal,
      activo
    } = req.body;

    if (esTextoVacio(nombre)) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const tipo = tipo_venta === "peso" ? "peso" : "unidad";

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
        precio_venta = $8,
        stock_minimo = $9,
        permite_decimal = $10,
        activo = $11,
        updated_at = NOW()
      WHERE id = $12
      RETURNING *
      `,
      [
        esTextoVacio(codigo_barras) ? null : String(codigo_barras).trim(),
        esTextoVacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        normalizarNumero(costo, 2),
        normalizarNumero(porcentaje_ganancia, 2),
        normalizarNumero(precio_venta, 2),
        normalizarNumero(stock_minimo, 3),
        Boolean(permite_decimal),
        activo === false ? false : true,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error editar producto:", error);
    res.status(500).json({ error: "Error al editar producto" });
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

    for (const item of items) {
      totalCompra += normalizarNumero(item.subtotal, 2);
    }

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
        normalizarNumero(totalCompra, 2)
      ]
    );

    const compra = compraResult.rows[0];

    for (const item of items) {
      const productoId = item.producto_id;
      const cantidad = normalizarNumero(item.cantidad, 3);
      const costoUnitario = normalizarNumero(item.costo_unitario, 2);
      const subtotal = normalizarNumero(item.subtotal, 2);

      await client.query(
        `
        INSERT INTO compras_detalle (compra_id, producto_id, cantidad, costo_unitario, subtotal)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [compra.id, productoId, cantidad, costoUnitario, subtotal]
      );

      await client.query(
        `
        UPDATE productos
        SET
          stock_actual = stock_actual + $1,
          costo = $2,
          updated_at = NOW()
        WHERE id = $3
        `,
        [cantidad, costoUnitario, productoId]
      );

      await client.query(
        `
        INSERT INTO stock_movimientos (
          producto_id, tipo, cantidad, referencia_tabla, referencia_id, empleado_id, observaciones
        )
        VALUES ($1, 'compra', $2, 'compras', $3, $4, $5)
        `,
        [productoId, cantidad, compra.id, empleado_id || null, observaciones || ""]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, compra_id: compra.id, compra });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error crear compra:", error);
    res.status(500).json({ error: "Error al guardar compra" });
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
    res.json(caja || null);
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
      [
        empleado_id || null,
        normalizarNumero(monto_inicial, 2),
        observaciones || ""
      ]
    );

    const caja = result.rows[0];

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id)
      VALUES ($1, 'apertura', $2, $3, $4)
      `,
      [caja.id, normalizarNumero(monto_inicial, 2), "Apertura de caja", empleado_id || null]
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
      [
        caja_sesion_id,
        tipo,
        normalizarNumero(monto, 2),
        motivo || "",
        empleado_id || null
      ]
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

    const cajaResult = await client.query(
      `
      SELECT *
      FROM caja_sesiones
      WHERE id = $1
      LIMIT 1
      `,
      [caja_sesion_id]
    );

    if (cajaResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Caja no encontrada" });
    }

    const caja = cajaResult.rows[0];

    const movimientosResult = await client.query(
      `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN tipo IN ('apertura', 'ingreso', 'venta_efectivo') THEN monto
            WHEN tipo IN ('retiro', 'cierre') THEN -monto
            ELSE 0
          END
        ), 0) AS saldo_sistema
      FROM caja_movimientos
      WHERE caja_sesion_id = $1
      `,
      [caja_sesion_id]
    );

    const saldoSistema = normalizarNumero(movimientosResult.rows[0].saldo_sistema, 2);
    const efectivoReal = normalizarNumero(efectivo_real, 2);
    const diferencia = normalizarNumero(efectivoReal - saldoSistema, 2);

    const updateResult = await client.query(
      `
      UPDATE caja_sesiones
      SET
        empleado_cierre_id = $1,
        fecha_cierre = NOW(),
        efectivo_real = $2,
        diferencia = $3,
        estado = 'cerrada',
        observaciones = COALESCE(observaciones, '') || $4
      WHERE id = $5
      RETURNING *
      `,
      [
        empleado_cierre_id || null,
        efectivoReal,
        diferencia,
        observaciones ? ` | ${observaciones}` : "",
        caja_sesion_id
      ]
    );

    await client.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id)
      VALUES ($1, 'cierre', $2, $3, $4)
      `,
      [
        caja_sesion_id,
        efectivoReal,
        "Cierre de caja",
        empleado_cierre_id || null
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      caja: updateResult.rows[0],
      saldo_sistema: saldoSistema,
      efectivo_real: efectivoReal,
      diferencia
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
    const result = await pool.query(`
      SELECT
        v.*,
        e.nombre AS empleado_nombre
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      ORDER BY v.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas:", error);
    res.status(500).json({ error: "Error al obtener ventas" });
  }
});

app.post("/api/ventas", async (req, res) => {
  const client = await pool.connect();

  try {
    const { empleado_id, forma_pago, observaciones, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "La venta debe tener al menos un producto" });
    }

    const cajaAbiertaResult = await client.query(`
      SELECT *
      FROM caja_sesiones
      WHERE estado = 'abierta'
      ORDER BY id DESC
      LIMIT 1
    `);

    const cajaAbierta = cajaAbiertaResult.rows[0] || null;

    await client.query("BEGIN");

    let totalVenta = 0;

    for (const item of items) {
      totalVenta += normalizarNumero(item.subtotal, 2);
    }

    const ventaResult = await client.query(
      `
      INSERT INTO ventas (caja_sesion_id, empleado_id, total, forma_pago, observaciones)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        cajaAbierta ? cajaAbierta.id : null,
        empleado_id || null,
        normalizarNumero(totalVenta, 2),
        forma_pago || "efectivo",
        observaciones || ""
      ]
    );

    const venta = ventaResult.rows[0];

    for (const item of items) {
      const productoId = item.producto_id;
      const cantidad = normalizarNumero(item.cantidad, 3);
      const precioUnitario = normalizarNumero(item.precio_unitario, 2);
      const subtotal = normalizarNumero(item.subtotal, 2);

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
      const stockActual = Number(producto.stock_actual || 0);

      if (stockActual < cantidad) {
        throw new Error(`Stock insuficiente para ${producto.nombre}`);
      }

      await client.query(
        `
        INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario, subtotal)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [venta.id, productoId, cantidad, precioUnitario, subtotal]
      );

      await client.query(
        `
        UPDATE productos
        SET
          stock_actual = stock_actual - $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [cantidad, productoId]
      );

      await client.query(
        `
        INSERT INTO stock_movimientos (
          producto_id, tipo, cantidad, referencia_tabla, referencia_id, empleado_id, observaciones
        )
        VALUES ($1, 'venta', $2, 'ventas', $3, $4, $5)
        `,
        [productoId, cantidad, venta.id, empleado_id || null, observaciones || ""]
      );
    }

    if (forma_pago === "efectivo" && cajaAbierta) {
      await client.query(
        `
        INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id, venta_id)
        VALUES ($1, 'venta_efectivo', $2, $3, $4, $5)
        `,
        [
          cajaAbierta.id,
          normalizarNumero(totalVenta, 2),
          "Venta en efectivo",
          empleado_id || null,
          venta.id
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      venta_id: venta.id,
      venta
    });
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
      ventas_hoy: normalizarNumero(ventasHoy.rows[0].total, 2),
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


app.listen(PORT, () => {
  console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
});
