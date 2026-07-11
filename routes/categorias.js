const express = require("express");

module.exports = function crearCategoriasRouter({ pool, vacio }) {
  const router = express.Router();

  // Listar categorías activas
  router.get("/categorias", async (req, res) => {
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

  // Crear categoría
  router.post("/categorias", async (req, res) => {
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

  return router;
};
