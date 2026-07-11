const express = require("express");

function vacio(valor) {
  return valor === undefined || valor === null || String(valor).trim() === "";
}

function permisosDesdeBody(body = {}) {
  return {
    puede_inicio: body.puede_inicio === true,
    puede_ventas: body.puede_ventas === true,
    puede_productos: body.puede_productos === true,
    puede_compras: body.puede_compras === true,
    puede_caja: body.puede_caja === true,
    puede_reportes: body.puede_reportes === true,
    puede_configuracion: body.puede_configuracion === true,
    puede_recetas: body.puede_recetas === true
  };
}

module.exports = function crearEmpleadosRouter({ pool }) {
  if (!pool) throw new Error("El módulo empleados necesita la conexión pool");

  const router = express.Router();

  router.get("/empleados", async (req, res) => {
    try {
      await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_actividad TIMESTAMP`).catch(() => {});
      await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS puede_recetas BOOLEAN DEFAULT false`).catch(() => {});

      const result = await pool.query(`
        SELECT *
        FROM empleados
        ORDER BY COALESCE(nombre, usuario, id::text) ASC
      `);

      const filas = result.rows.map(e => ({
        id: e.id,
        nombre: e.nombre || "",
        usuario: e.usuario || "",
        password: e.password || "",
        rol: e.rol || "",
        activo: e.activo === false ? false : true,
        puede_inicio: e.puede_inicio === true,
        puede_ventas: e.puede_ventas === true,
        puede_productos: e.puede_productos === true,
        puede_compras: e.puede_compras === true,
        puede_recetas: e.puede_recetas === true,
        puede_caja: e.puede_caja === true,
        puede_reportes: e.puede_reportes === true,
        puede_configuracion: e.puede_configuracion === true,
        ultima_actividad: e.ultima_actividad || null,
        created_at: e.created_at || null
      }));

      res.json(filas);
    } catch (error) {
      console.error("Error empleados:", error);
      res.status(500).json({ error: "Error al obtener empleados", detalle: error.message });
    }
  });

  router.get("/empleados/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `
        SELECT
          id, nombre, usuario, password, rol, activo,
          puede_inicio, puede_ventas, puede_productos, puede_compras,
          puede_recetas, puede_caja, puede_reportes, puede_configuracion,
          ultima_actividad, created_at
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

  router.post("/empleados", async (req, res) => {
    try {
      const { nombre, usuario, password, rol, activo } = req.body;
      const permisos = permisosDesdeBody(req.body);

      if (vacio(nombre) || vacio(usuario) || vacio(password)) {
        return res.status(400).json({ error: "Nombre, usuario y contraseña son obligatorios" });
      }

      const result = await pool.query(
        `
        INSERT INTO empleados (
          nombre, usuario, password, rol, activo,
          puede_inicio, puede_ventas, puede_productos, puede_compras,
          puede_recetas, puede_caja, puede_reportes, puede_configuracion
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING
          id, nombre, usuario, password, rol, activo,
          puede_inicio, puede_ventas, puede_productos, puede_compras,
          puede_recetas, puede_caja, puede_reportes, puede_configuracion,
          created_at
        `,
        [
          String(nombre).trim(),
          String(usuario).trim(),
          String(password).trim(),
          vacio(rol) ? "cajero" : String(rol).trim(),
          activo === false ? false : true,
          permisos.puede_inicio, permisos.puede_ventas,
          permisos.puede_productos, permisos.puede_compras,
          permisos.puede_recetas, permisos.puede_caja,
          permisos.puede_reportes, permisos.puede_configuracion
        ]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Error crear empleado:", error);
      res.status(500).json({ error: "Error al crear empleado" });
    }
  });

  router.put("/empleados/:id", async (req, res) => {
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
          nombre = $1, usuario = $2, password = $3, rol = $4, activo = $5,
          puede_inicio = $6, puede_ventas = $7, puede_productos = $8,
          puede_compras = $9, puede_recetas = $10, puede_caja = $11,
          puede_reportes = $12, puede_configuracion = $13
        WHERE id = $14
        RETURNING
          id, nombre, usuario, password, rol, activo,
          puede_inicio, puede_ventas, puede_productos, puede_compras,
          puede_recetas, puede_caja, puede_reportes, puede_configuracion,
          created_at
        `,
        [
          String(nombre).trim(),
          String(usuario).trim(),
          String(password).trim(),
          vacio(rol) ? "cajero" : String(rol).trim(),
          activo === false ? false : true,
          permisos.puede_inicio, permisos.puede_ventas,
          permisos.puede_productos, permisos.puede_compras,
          permisos.puede_recetas, permisos.puede_caja,
          permisos.puede_reportes, permisos.puede_configuracion, id
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

  return router;
};
