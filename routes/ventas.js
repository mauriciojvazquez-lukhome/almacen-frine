const express = require("express");

module.exports = function crearVentasRouter({ pool, n2, n3, registrarActividadEmpleado }) {
  const router = express.Router();

// ==========================================
// VENTAS
// ==========================================

router.get("/ventas", async (req, res) => {
  try {
    const { desde, hasta, forma_pago, q } = req.query;

    const condiciones = [];
    const valores = [];
    let i = 1;

    // FIX HISTORIAL VENTAS:
    // Se usa v.fecha::date para evitar que el filtro de fecha quede corrido por zona horaria
    // y deje el historial en cero aunque existan ventas cargadas.
    if (desde) {
      condiciones.push(`v.fecha::date >= $${i++}::date`);
      valores.push(String(desde).trim());
    }

    if (hasta) {
      condiciones.push(`v.fecha::date <= $${i++}::date`);
      valores.push(String(hasta).trim());
    }

    if (forma_pago) {
      condiciones.push(`LOWER(COALESCE(v.forma_pago, '')) = $${i++}`);
      valores.push(String(forma_pago).trim().toLowerCase());
    }

    if (q) {
      condiciones.push(`(
        CAST(v.id AS TEXT) ILIKE $${i}
        OR COALESCE(e.nombre, '') ILIKE $${i}
        OR COALESCE(c.nombre, '') ILIKE $${i}
        OR COALESCE(v.observaciones, '') ILIKE $${i}
        OR EXISTS (
          SELECT 1
          FROM ventas_detalle vdq
          LEFT JOIN productos pq ON pq.id = vdq.producto_id
          WHERE vdq.venta_id = v.id
            AND (
              COALESCE(pq.nombre, '') ILIKE $${i}
              OR COALESCE(pq.codigo_barras, '') ILIKE $${i}
              OR COALESCE(pq.plu, '') ILIKE $${i}
            )
        )
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
        c.nombre AS cliente_nombre,
        COALESCE(det.productos_vendidos, '') AS productos_vendidos
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(
          COALESCE(p.nombre, 'Producto') || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM COALESCE(vd.cantidad, 0)::numeric::text)),
          ', ' ORDER BY vd.id
        ) AS productos_vendidos
        FROM ventas_detalle vd
        LEFT JOIN productos p ON p.id = vd.producto_id
        WHERE vd.venta_id = v.id
      ) det ON true
      ${where}
      ORDER BY v.id DESC
      LIMIT 500
      `,
      valores
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas:", error);
    res.status(500).json({ error: "Error al obtener ventas", detalle: error.message });
  }
});

router.get("/ventas/:id", async (req, res) => {
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


router.post("/ventas", async (req, res) => {
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



  return router;
};
