const express = require("express");

module.exports = function crearClientesRouter({ pool, n2, vacio }) {
  const router = express.Router();

  // Listar clientes activos con el saldo de cuenta corriente.
  router.get("/clientes", async (req, res) => {
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

  // Crear un cliente.
  router.post("/clientes", async (req, res) => {
    try {
      const { nombre, telefono, direccion, limite_credito, observaciones } = req.body;

      if (vacio(nombre)) {
        return res.status(400).json({ error: "El nombre del cliente es obligatorio" });
      }

      const result = await pool.query(
        `
        INSERT INTO clientes (nombre, telefono, direccion, limite_credito, observaciones)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          String(nombre).trim(),
          telefono || "",
          direccion || "",
          n2(limite_credito),
          observaciones || ""
        ]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Error crear cliente:", error);
      res.status(500).json({ error: "Error al crear cliente" });
    }
  });

  // Registrar un pago de cuenta corriente.
  router.post("/clientes/:id/pagos", async (req, res) => {
    try {
      const { id } = req.params;
      const { monto, observaciones, empleado_id } = req.body;
      const montoNum = n2(monto);

      if (montoNum <= 0) {
        return res.status(400).json({ error: "El monto del pago debe ser mayor a 0" });
      }

      const cliente = await pool.query(
        "SELECT * FROM clientes WHERE id=$1 AND activo=true LIMIT 1",
        [id]
      );

      if (!cliente.rows.length) {
        return res.status(404).json({ error: "Cliente no encontrado" });
      }

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

  // Consultar todos los movimientos de un cliente.
  router.get("/clientes/:id/movimientos", async (req, res) => {
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

  return router;
};
