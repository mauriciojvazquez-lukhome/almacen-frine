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

function n2(valor) {
  return Number(Number(valor || 0).toFixed(2));
}

function n3(valor) {
  return Number(Number(valor || 0).toFixed(3));
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

    if (vacio(nombre)) {
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
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        n2(costo),
        n2(porcentaje_ganancia),
        n2(precio_venta),
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
      precio_venta,
      stock_minimo,
      permite_decimal,
      activo
    } = req.body;

    if (vacio(nombre)) {
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
        vacio(codigo_barras) ? null : String(codigo_barras).trim(),
        vacio(plu) ? null : String(plu).trim(),
        String(nombre).trim(),
        categoria_id || null,
        tipo,
        n2(costo),
        n2(porcentaje_ganancia),
        n2(precio_venta),
        n3(stock_minimo),
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
      const cantidad = n3(item.cantidad);
      const costoUnitario = n2(item.costo_unitario);
      const subtotal = n2(item.subtotal);

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
      const porcentajeGanancia = n2(producto.porcentaje_ganancia || 0);
      const precioVentaActual = n2(producto.precio_venta || 0);
      const precioSugeridoNuevo = n2(costoUnitario * (1 + porcentajeGanancia / 100));
      const debeActualizarPrecio = precioSugeridoNuevo > precioVentaActual;

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
          precio_venta = CASE
            WHEN $3 > precio_venta THEN $3
            ELSE precio_venta
          END,
          updated_at = NOW()
        WHERE id = $4
        `,
        [cantidad, costoUnitario, precioSugeridoNuevo, productoId]
      );

      if (debeActualizarPrecio) {
        preciosActualizados.push({
          producto_id: producto.id,
          nombre: producto.nombre,
          precio_anterior: precioVentaActual,
          precio_nuevo: precioSugeridoNuevo,
          costo_nuevo: costoUnitario,
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
        [productoId, cantidad, compra.id, empleado_id || null, observaciones || ""]
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

    const saldoSistema = n2(movimientosResult.rows[0].saldo_sistema);
    const efectivoReal = n2(efectivo_real);
    const diferencia = n2(efectivoReal - saldoSistema);

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
      [caja_sesion_id, efectivoReal, "Cierre de caja", empleado_cierre_id || null]
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

    if (formaPagoNormalizada === "efectivo" && !cajaAbierta) {
      return res.status(400).json({ error: "No hay caja abierta para cobrar una venta en efectivo" });
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
        cajaAbierta ? cajaAbierta.id : null,
        empleado_id || null,
        n2(totalVenta),
        formaPagoNormalizada,
        observaciones || ""
      ]
    );

    const venta = ventaResult.rows[0];

    for (const item of items) {
      const productoId = item.producto_id;
      const cantidad = n3(item.cantidad);
      const precioUnitario = n2(item.precio_unitario);
      const subtotal = n2(item.subtotal);

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

    if (formaPagoNormalizada === "efectivo" && cajaAbierta) {
      await client.query(
        `
        INSERT INTO caja_movimientos (caja_sesion_id, tipo, monto, motivo, empleado_id, venta_id)
        VALUES ($1, 'venta_efectivo', $2, $3, $4, $5)
        `,
        [cajaAbierta.id, n2(totalVenta), "Venta en efectivo", empleado_id || null, venta.id]
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

app.listen(PORT, () => {
  console.log(`Servidor Almacén Frine corriendo en puerto ${PORT}`);
});
