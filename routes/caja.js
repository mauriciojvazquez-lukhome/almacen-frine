const express = require("express");

module.exports = function crearCajaRouter({
  pool,
  n2,
  buscarCajaAbierta,
  calcularResumenCaja,
  registrarActividadEmpleado
}) {
  const router = express.Router();

router.get("/caja/abierta", async (req, res) => {
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

router.post("/caja/abrir", async (req, res) => {
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

router.post("/caja/movimiento", async (req, res) => {
  try {
    const { caja_sesion_id, tipo, monto, motivo, empleado_id, medio_pago, tipo_retiro } = req.body;

    if (!caja_sesion_id) {
      return res.status(400).json({ error: "Caja no informada" });
    }

    if (!["ingreso", "retiro"].includes(tipo)) {
      return res.status(400).json({ error: "Tipo inválido" });
    }

    const medioPagoFinal = String(medio_pago || "efectivo").toLowerCase() === "transferencia" ? "transferencia" : "efectivo";
    const tiposRetiroValidos = ["sueldo_empleado", "adelanto_empleado", "gasto_negocio", "pago_proveedor", "otro"];
    const tipoRetiroFinal = tipo === "retiro" && tiposRetiroValidos.includes(String(tipo_retiro || "")) ? String(tipo_retiro) : (tipo === "retiro" ? "otro" : null);
    const rrhhEmpleadoId = ["sueldo_empleado", "adelanto_empleado"].includes(tipoRetiroFinal) ? (empleado_id || null) : null;
    const motivoFinal = motivo || (tipoRetiroFinal === "sueldo_empleado" ? "Retiro por sueldo" : tipoRetiroFinal === "adelanto_empleado" ? "Retiro por adelanto" : "");

    await registrarActividadEmpleado(pool, empleado_id);

    const result = await pool.query(
      `
      INSERT INTO caja_movimientos (caja_sesion_id, tipo, medio_pago, monto, motivo, empleado_id, tipo_retiro, rrhh_empleado_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [caja_sesion_id, tipo, medioPagoFinal, n2(monto), motivoFinal, empleado_id || null, tipoRetiroFinal, rrhhEmpleadoId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error movimiento caja:", error);
    res.status(500).json({ error: "Error al registrar movimiento de caja" });
  }
});

router.get("/caja/movimientos/:caja_sesion_id", async (req, res) => {
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

router.post("/caja/cerrar", async (req, res) => {
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

  return router;
};
