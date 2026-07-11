const express = require("express");

function vacio(valor) {
  return valor === undefined || valor === null || String(valor).trim() === "";
}

module.exports = function crearProveedoresRouter({ pool }) {
  if (!pool) throw new Error("El módulo proveedores necesita la conexión pool");

  const router = express.Router();

  router.get("/proveedores", async (req, res) => {
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

  router.post("/proveedores", async (req, res) => {
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

  router.put("/proveedores/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { nombre, telefono, direccion, observaciones, activo } = req.body;

      if (vacio(nombre)) {
        return res.status(400).json({ error: "El nombre del proveedor es obligatorio" });
      }

      const result = await pool.query(
        `
        UPDATE proveedores
        SET
          nombre = $1,
          telefono = $2,
          direccion = $3,
          observaciones = $4,
          activo = $5,
          updated_at = NOW()
        WHERE id = $6
        RETURNING *
        `,
        [
          String(nombre).trim(),
          telefono || "",
          direccion || "",
          observaciones || "",
          activo === false ? false : true,
          id
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Proveedor no encontrado" });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Error editar proveedor:", error);
      res.status(500).json({ error: "Error al editar proveedor" });
    }
  });

  router.delete("/proveedores/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        UPDATE proveedores
        SET activo = false, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Proveedor no encontrado" });
      }

      res.json({ ok: true, proveedor: result.rows[0] });
    } catch (error) {
      console.error("Error eliminar proveedor:", error);
      res.status(500).json({ error: "Error al eliminar proveedor" });
    }
  });

  return router;
};
