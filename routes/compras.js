const express = require("express");

module.exports = function crearComprasRouter({
  pool,
  n2,
  n3,
  redondearPrecio,
  recalcularPresentacionesProducto,
  registrarActividadEmpleado
}) {
  const router = express.Router();

  router.get("/compras", async (req, res) => {
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

  router.post("/compras", async (req, res) => {
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



  return router;
};
