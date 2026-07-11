const express = require("express");

module.exports = function crearProductosRouter({
  pool,
  n2,
  n3,
  vacio,
  calcularPrecioVenta,
  recalcularPresentacionesProducto
}) {
  const router = express.Router();

  // ==========================================
  // PRODUCTOS
  // ==========================================
  router.get("/productos", async (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q).trim() : "";
      const categoriaId = req.query.categoria_id ? Number(req.query.categoria_id) : null;

      let result;

      if (q || categoriaId) {
        result = await pool.query(
          `
          SELECT
            p.*,
            c.nombre AS categoria_nombre
          FROM productos p
          LEFT JOIN categorias c ON c.id = p.categoria_id
          WHERE p.activo = true
            AND ($2::integer IS NULL OR p.categoria_id = $2)
            AND (
              p.nombre ILIKE $1
              OR COALESCE(p.codigo_barras, '') ILIKE $1
              OR COALESCE(p.plu, '') ILIKE $1
            )
          ORDER BY p.nombre ASC
          `,
          [`%${q}%`, categoriaId]
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

  router.get("/productos/:id", async (req, res) => {
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

  router.get("/productos/codigo/:codigo", async (req, res) => {
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

  router.post("/productos", async (req, res) => {
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

  router.put("/productos/:id", async (req, res) => {
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
  router.get("/productos/:id/presentaciones", async (req, res) => {
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

  router.post("/productos/:id/presentaciones", async (req, res) => {
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

  router.put("/productos/:id/presentaciones/:presentacion_id", async (req, res) => {
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

  router.delete("/productos/:id/presentaciones/:presentacion_id", async (req, res) => {
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

  router.get("/productos/:id/codigos", async (req, res) => {
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

  router.post("/productos/:id/codigos", async (req, res) => {
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

  router.delete("/productos/:id/codigos/:codigo_id", async (req, res) => {
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

  router.post("/productos/:id/ajustar-stock", async (req, res) => {
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

  router.post("/productos/:id/dar-baja", async (req, res) => {
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




  return router;
};
