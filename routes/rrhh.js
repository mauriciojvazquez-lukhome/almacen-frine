const express = require("express");

/**
 * Rutas de RR.HH. de Almacén Frine.
 * Gestiona el resumen de sueldos y adelantos registrados desde Caja.
 */
module.exports = function crearRrhhRouter({ pool }) {
  const router = express.Router();

  router.get("/rrhh/resumen", async (req, res) => {
    try {
      const { desde, hasta, empleado_id } = req.query;
      const params = [];
      const where = [
        "cm.tipo = 'retiro'",
        "cm.tipo_retiro IN ('sueldo_empleado', 'adelanto_empleado')"
      ];

      if (desde) {
        params.push(desde);
        where.push(
          `(cm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $${params.length}::date`
        );
      }

      if (hasta) {
        params.push(hasta);
        where.push(
          `(cm.fecha AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $${params.length}::date`
        );
      }

      if (empleado_id) {
        params.push(empleado_id);
        where.push(
          `COALESCE(cm.rrhh_empleado_id, cm.empleado_id) = $${params.length}`
        );
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
        LEFT JOIN empleados e
          ON e.id = COALESCE(cm.rrhh_empleado_id, cm.empleado_id)
        WHERE ${whereSql}
        GROUP BY
          COALESCE(cm.rrhh_empleado_id, cm.empleado_id),
          e.nombre,
          e.usuario
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
        LEFT JOIN empleados e
          ON e.id = COALESCE(cm.rrhh_empleado_id, cm.empleado_id)
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

  return router;
};
