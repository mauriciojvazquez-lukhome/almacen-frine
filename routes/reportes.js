const express = require("express");

module.exports = function crearReportesRouter({
  pool,
  n2,
  n3,
  buscarCajaAbierta,
  calcularResumenCaja,
  SQL_HOY_ARGENTINA
}) {
  const router = express.Router();

// ==========================================
// REPORTES
// ==========================================
router.get("/reportes/resumen", async (req, res) => {
  try {
    const ventasHoy = await pool.query(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    `);

    const cantidadVentasHoy = await pool.query(`
      SELECT COUNT(*) AS cantidad
      FROM ventas
      WHERE ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
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

router.get("/reportes/ventas-por-producto", async (req, res) => {
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

router.get("/reportes/ventas-por-empleado", async (req, res) => {
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

router.get("/reportes/ventas-diarias", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS fecha,
        COUNT(*) AS cantidad_ventas,
        COALESCE(SUM(total), 0) AS total_vendido
      FROM ventas
      GROUP BY ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
      ORDER BY ((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error ventas diarias:", error);
    res.status(500).json({ error: "Error al obtener ventas diarias" });
  }
});

router.get("/reportes/stock-bajo", async (req, res) => {
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


router.get("/reportes/inventario-resumen", async (req, res) => {
  try {
    const { estado, q } = req.query;
    const condiciones = ["p.activo = true"];
    const valores = [];
    let i = 1;

    if (q && String(q).trim()) {
      valores.push(`%${String(q).trim()}%`);
      condiciones.push(`(
        p.nombre ILIKE $${i}
        OR COALESCE(p.codigo_barras, '') ILIKE $${i}
        OR COALESCE(p.plu, '') ILIKE $${i}
      )`);
      i++;
    }

    if (estado === "sin") {
      condiciones.push("COALESCE(p.stock_actual, 0) <= 0");
    } else if (estado === "bajo") {
      condiciones.push("COALESCE(p.stock_actual, 0) > 0 AND COALESCE(p.stock_actual, 0) <= COALESCE(p.stock_minimo, 0)");
    } else if (estado === "ok") {
      condiciones.push("COALESCE(p.stock_actual, 0) > COALESCE(p.stock_minimo, 0)");
    }

    const where = condiciones.join(" AND ");

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.nombre,
        p.codigo_barras,
        p.plu,
        p.tipo_venta,
        COALESCE(p.costo, 0) AS costo,
        COALESCE(p.precio_venta, 0) AS precio_venta,
        COALESCE(p.porcentaje_ganancia, 0) AS porcentaje_ganancia,
        COALESCE(p.stock_actual, 0) AS stock_actual,
        COALESCE(p.stock_minimo, 0) AS stock_minimo,
        COALESCE(p.cantidad_bulto, 1) AS cantidad_bulto,
        ROUND((COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0))::numeric, 2) AS costo_unitario_real,
        ROUND((COALESCE(p.stock_actual, 0) * (COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0)))::numeric, 2) AS total_costo,
        ROUND((COALESCE(p.stock_actual, 0) * COALESCE(p.precio_venta, 0))::numeric, 2) AS total_venta,
        ROUND((COALESCE(p.stock_actual, 0) * (COALESCE(p.precio_venta, 0) - (COALESCE(p.costo, 0) / NULLIF(COALESCE(p.cantidad_bulto, 1), 0))))::numeric, 2) AS total_ganancia
      FROM productos p
      WHERE ${where}
      ORDER BY p.nombre ASC
      `,
      valores
    );

    const resumen = result.rows.reduce((acc, p) => {
      acc.productos += 1;
      acc.total_costo += Number(p.total_costo || 0);
      acc.total_venta += Number(p.total_venta || 0);
      acc.total_ganancia += Number(p.total_ganancia || 0);
      return acc;
    }, { productos: 0, total_costo: 0, total_venta: 0, total_ganancia: 0 });

    resumen.total_costo = n2(resumen.total_costo);
    resumen.total_venta = n2(resumen.total_venta);
    resumen.total_ganancia = n2(resumen.total_ganancia);

    res.json({ items: result.rows, resumen });
  } catch (error) {
    console.error("Error resumen inventario:", error);
    res.status(500).json({ error: "Error al obtener resumen de inventario" });
  }
});

router.get("/reportes/compras", async (req, res) => {
  try {
    const { desde, hasta, proveedor_id, producto_id, q } = req.query;

    const columnasFecha = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'compras'
        AND column_name IN ('fecha', 'created_at')
    `);

    const nombresColumnas = columnasFecha.rows.map(r => r.column_name);
    const fechaColumna = nombresColumnas.includes('fecha')
      ? 'fecha'
      : nombresColumnas.includes('created_at')
      ? 'created_at'
      : null;

    const condiciones = [];
    const valores = [];
    let i = 1;

    if (desde && fechaColumna) {
      condiciones.push(`((c.${fechaColumna} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) >= $${i++}`);
      valores.push(desde);
    }

    if (hasta && fechaColumna) {
      condiciones.push(`((c.${fechaColumna} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) <= $${i++}`);
      valores.push(hasta);
    }

    if (proveedor_id) {
      condiciones.push(`c.proveedor_id = $${i++}`);
      valores.push(proveedor_id);
    }

    if (producto_id) {
      condiciones.push(`cd.producto_id = $${i++}`);
      valores.push(producto_id);
    }

    if (q) {
      condiciones.push(`(
        COALESCE(pr.nombre, '') ILIKE $${i}
        OR COALESCE(p.nombre, '') ILIKE $${i}
        OR COALESCE(c.observaciones, '') ILIKE $${i}
        OR CAST(c.id AS TEXT) ILIKE $${i}
      )`);
      valores.push(`%${String(q).trim()}%`);
      i++;
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
    const campoFecha = fechaColumna ? `c.${fechaColumna}` : `NULL::timestamp`;
    const ordenFecha = fechaColumna ? `c.${fechaColumna} DESC,` : "";

    const result = await pool.query(
      `
      SELECT
        c.id AS compra_id,
        ${campoFecha} AS fecha,
        c.total AS compra_total,
        c.observaciones,
        pr.id AS proveedor_id,
        pr.nombre AS proveedor_nombre,
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        cd.cantidad,
        cd.costo_unitario,
        cd.subtotal,
        e.nombre AS empleado_nombre
      FROM compras c
      INNER JOIN compras_detalle cd ON cd.compra_id = c.id
      LEFT JOIN proveedores pr ON pr.id = c.proveedor_id
      LEFT JOIN productos p ON p.id = cd.producto_id
      LEFT JOIN empleados e ON e.id = c.empleado_id
      ${where}
      ORDER BY ${ordenFecha} c.id DESC, cd.id DESC
      `,
      valores
    );

    const movimientos = result.rows;
    const comprasUnicas = new Set();
    const proveedoresUnicos = new Set();
    const productosUnicos = new Set();
    let totalGastado = 0;

    movimientos.forEach(r => {
      comprasUnicas.add(r.compra_id);
      if (r.proveedor_id) proveedoresUnicos.add(r.proveedor_id);
      if (r.producto_id) productosUnicos.add(r.producto_id);
      totalGastado += Number(r.subtotal || 0);
    });

    const mapaProveedor = new Map();
    const mapaProducto = new Map();
    const mapaComparativa = new Map();

    movimientos.forEach(r => {
      const keyProv = r.proveedor_id || 'sin-proveedor';
      if (!mapaProveedor.has(keyProv)) {
        mapaProveedor.set(keyProv, {
          proveedor_id: r.proveedor_id,
          proveedor_nombre: r.proveedor_nombre || 'Sin proveedor',
          compras: new Set(),
          total_comprado: 0,
          ultimo_precio: Number(r.costo_unitario || 0),
          ultima_fecha: r.fecha || null,
          ultimo_ts: r.fecha ? new Date(r.fecha).getTime() : 0
        });
      }
      const prov = mapaProveedor.get(keyProv);
      prov.compras.add(r.compra_id);
      prov.total_comprado += Number(r.subtotal || 0);
      const provTs = r.fecha ? new Date(r.fecha).getTime() : 0;
      if (provTs >= prov.ultimo_ts) {
        prov.ultimo_ts = provTs;
        prov.ultimo_precio = Number(r.costo_unitario || 0);
        prov.ultima_fecha = r.fecha || null;
      }

      const keyProd = r.producto_id || 'sin-producto';
      if (!mapaProducto.has(keyProd)) {
        mapaProducto.set(keyProd, {
          producto_id: r.producto_id,
          producto_nombre: r.producto_nombre || '-',
          veces_comprado: 0,
          cantidad_total: 0,
          total_comprado: 0,
          ultimo_precio: Number(r.costo_unitario || 0),
          ultima_fecha: r.fecha || null,
          ultimo_ts: r.fecha ? new Date(r.fecha).getTime() : 0
        });
      }
      const prod = mapaProducto.get(keyProd);
      prod.veces_comprado += 1;
      prod.cantidad_total += Number(r.cantidad || 0);
      prod.total_comprado += Number(r.subtotal || 0);
      const prodTs = r.fecha ? new Date(r.fecha).getTime() : 0;
      if (prodTs >= prod.ultimo_ts) {
        prod.ultimo_ts = prodTs;
        prod.ultimo_precio = Number(r.costo_unitario || 0);
        prod.ultima_fecha = r.fecha || null;
      }

      if (producto_id && String(r.producto_id || '') === String(producto_id)) {
        const keyComp = r.proveedor_id || 'sin-proveedor';
        if (!mapaComparativa.has(keyComp)) {
          mapaComparativa.set(keyComp, {
            proveedor_id: r.proveedor_id,
            proveedor_nombre: r.proveedor_nombre || 'Sin proveedor',
            veces_comprado: 0,
            suma_precios: 0,
            precio_minimo: Number(r.costo_unitario || 0),
            precio_maximo: Number(r.costo_unitario || 0),
            ultimo_precio: Number(r.costo_unitario || 0),
            ultima_fecha: r.fecha || null,
            ultimo_ts: prodTs
          });
        }
        const comp = mapaComparativa.get(keyComp);
        const precio = Number(r.costo_unitario || 0);
        comp.veces_comprado += 1;
        comp.suma_precios += precio;
        comp.precio_minimo = Math.min(comp.precio_minimo, precio);
        comp.precio_maximo = Math.max(comp.precio_maximo, precio);
        if (prodTs >= comp.ultimo_ts) {
          comp.ultimo_ts = prodTs;
          comp.ultimo_precio = precio;
          comp.ultima_fecha = r.fecha || null;
        }
      }
    });

    const por_proveedor = Array.from(mapaProveedor.values())
      .map(r => ({
        proveedor_id: r.proveedor_id,
        proveedor_nombre: r.proveedor_nombre,
        cantidad_compras: r.compras.size,
        total_comprado: n2(r.total_comprado),
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => b.total_comprado - a.total_comprado);

    const por_producto = Array.from(mapaProducto.values())
      .map(r => ({
        producto_id: r.producto_id,
        producto_nombre: r.producto_nombre,
        veces_comprado: r.veces_comprado,
        cantidad_total: n3(r.cantidad_total),
        total_comprado: n2(r.total_comprado),
        precio_promedio: r.cantidad_total ? n2(r.total_comprado / r.cantidad_total) : 0,
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => b.total_comprado - a.total_comprado);

    const comparativa_producto = Array.from(mapaComparativa.values())
      .map(r => ({
        proveedor_id: r.proveedor_id,
        proveedor_nombre: r.proveedor_nombre,
        veces_comprado: r.veces_comprado,
        precio_promedio: r.veces_comprado ? n2(r.suma_precios / r.veces_comprado) : 0,
        precio_minimo: n2(r.precio_minimo),
        precio_maximo: n2(r.precio_maximo),
        ultimo_precio: n2(r.ultimo_precio),
        ultima_fecha: r.ultima_fecha
      }))
      .sort((a, b) => a.precio_promedio - b.precio_promedio);

    res.json({
      resumen: {
        compras_unicas: comprasUnicas.size,
        total_gastado: n2(totalGastado),
        proveedores_unicos: proveedoresUnicos.size,
        productos_unicos: productosUnicos.size
      },
      movimientos,
      por_proveedor,
      por_producto,
      comparativa_producto
    });
  } catch (error) {
    console.error("Error reporte compras:", error);
    res.status(500).json({ error: "Error al obtener reporte de compras" });
  }
});



router.get("/reportes/usuarios", async (req, res) => {
  console.log("GET /api/reportes/usuarios llamado");
  try {
    await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ultima_actividad TIMESTAMP`).catch(() => {});

    const empleadosResult = await pool.query(`
      SELECT
        id,
        COALESCE(nombre, '') AS nombre,
        COALESCE(usuario, '') AS usuario,
        COALESCE(rol, '') AS rol,
        COALESCE(activo, true) AS activo,
        ultima_actividad,
        CASE
          WHEN ultima_actividad IS NOT NULL
           AND ultima_actividad >= (CURRENT_TIMESTAMP - INTERVAL '30 minutes')
          THEN true ELSE false
        END AS en_linea,
        CASE
          WHEN ultima_actividad IS NULL THEN null
          ELSE GREATEST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ultima_actividad))::int, 0)
        END AS segundos_sin_actividad
      FROM empleados
      ORDER BY COALESCE(nombre, usuario, id::text) ASC
    `);

    const empleados = empleadosResult.rows || [];
    const activos = empleados.filter(e => e.activo !== false);
    const usuariosEnLinea = activos
      .filter(e => e.en_linea === true)
      .map(e => ({
        id: e.id,
        nombre: e.nombre,
        usuario: e.usuario,
        rol: e.rol,
        ultima_actividad: e.ultima_actividad,
        segundos_sin_actividad: Number(e.segundos_sin_actividad || 0)
      }));

    let cajasAbiertas = [];
    try {
      const cajasResult = await pool.query(`
        SELECT
          cs.id,
          cs.fecha_apertura,
          cs.estado,
          cs.empleado_apertura_id AS empleado_id,
          COALESCE(e.nombre, 'Sin empleado') AS cajero_nombre,
          COALESCE(e.usuario, '') AS cajero_usuario,
          COALESCE(e.rol, '') AS cajero_rol,
          GREATEST(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - cs.fecha_apertura))::int, 0) AS segundos_abierta
        FROM caja_sesiones cs
        LEFT JOIN empleados e ON e.id = cs.empleado_apertura_id
        WHERE LOWER(TRIM(COALESCE(cs.estado::text, ''))) = 'abierta'
        ORDER BY cs.fecha_apertura ASC
      `);

      cajasAbiertas = (cajasResult.rows || []).map(c => ({
        id: c.id,
        fecha_apertura: c.fecha_apertura,
        estado: c.estado || "abierta",
        empleado_id: c.empleado_id,
        cajero_nombre: c.cajero_nombre || "Sin empleado",
        cajero_usuario: c.cajero_usuario || "",
        cajero_rol: c.cajero_rol || "",
        segundos_abierta: Number(c.segundos_abierta || 0),
        caja_olvidada: Number(c.segundos_abierta || 0) >= 12 * 60 * 60
      }));
    } catch (errorCajas) {
      console.warn("Reporte usuarios: no se pudieron leer cajas abiertas:", errorCajas.message);
      cajasAbiertas = [];
    }

    res.json({
      ok: true,
      resumen: {
        usuarios_registrados: empleados.length,
        usuarios_activos: activos.length,
        usuarios_en_linea: usuariosEnLinea.length,
        cajas_abiertas: cajasAbiertas.length
      },
      usuarios_en_linea: usuariosEnLinea,
      cajas_abiertas: cajasAbiertas,
      cajas_olvidadas: cajasAbiertas.filter(c => c.caja_olvidada)
    });
  } catch (error) {
    console.error("Error reporte usuarios:", error);
    res.status(500).json({
      ok: false,
      error: "Error al obtener reporte de usuarios",
      detalle: error.message
    });
  }
});

router.get("/reportes/cajeros", async (req, res) => {
  try {
    const { desde, hasta, empleado_id } = req.query;

    const condiciones = ["cs.estado = 'cerrada'"];
    const valores = [];
    let i = 1;

    if (desde) {
      condiciones.push(`((cs.fecha_cierre AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) >= $${i++}::date`);
      valores.push(desde);
    }

    if (hasta) {
      condiciones.push(`((cs.fecha_cierre AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) <= $${i++}::date`);
      valores.push(hasta);
    }

    if (empleado_id) {
      condiciones.push(`cs.empleado_apertura_id = $${i++}`);
      valores.push(empleado_id);
    }

    const where = `WHERE ${condiciones.join(" AND ")}`;

    const result = await pool.query(
      `
      SELECT
        cs.id,
        cs.fecha_apertura,
        cs.fecha_cierre,
        cs.monto_inicial,
        cs.caja_esperada,
        cs.ventas_efectivo,
        cs.ventas_transferencia,
        cs.ventas_cuenta_corriente,
        cs.transferencia_real,
        cs.transferencia_esperada,
        cs.diferencia_transferencia,
        cs.ingresos_efectivo,
        cs.ingresos_transferencia,
        cs.retiros_efectivo,
        cs.retiros_transferencia,
        cs.ventas_debito,
        cs.ventas_credito,
        cs.ingresos_manuales,
        cs.retiros,
        cs.efectivo_real,
        cs.diferencia,
        cs.observaciones,
        ea.id AS empleado_id,
        ea.nombre AS cajero_nombre,
        ec.nombre AS empleado_cierre_nombre
      FROM caja_sesiones cs
      LEFT JOIN empleados ea ON ea.id = cs.empleado_apertura_id
      LEFT JOIN empleados ec ON ec.id = cs.empleado_cierre_id
      ${where}
      ORDER BY cs.fecha_cierre DESC, cs.id DESC
      `,
      valores
    );

    const cierres = result.rows.map(r => {
      const totalVentas = n2(
        Number(r.ventas_efectivo || 0) +
        Number(r.ventas_transferencia || 0) +
        Number(r.ventas_debito || 0) +
        Number(r.ventas_credito || 0)
      );
      const diferencia = n2(r.diferencia);
      return {
        ...r,
        monto_inicial: n2(r.monto_inicial),
        ventas_efectivo: n2(r.ventas_efectivo),
        ventas_transferencia: n2(r.ventas_transferencia),
        ventas_cuenta_corriente: n2(r.ventas_cuenta_corriente),
        transferencia_real: n2(r.transferencia_real),
        transferencia_esperada: n2(r.transferencia_esperada),
        diferencia_transferencia: n2(r.diferencia_transferencia),
        ingresos_efectivo: n2(r.ingresos_efectivo),
        ingresos_transferencia: n2(r.ingresos_transferencia),
        retiros_efectivo: n2(r.retiros_efectivo),
        retiros_transferencia: n2(r.retiros_transferencia),
        ventas_debito: n2(r.ventas_debito),
        ventas_credito: n2(r.ventas_credito),
        total_ventas: totalVentas,
        ingresos_manuales: n2(r.ingresos_manuales),
        retiros: n2(r.retiros),
        caja_esperada: n2(r.caja_esperada),
        efectivo_real: n2(r.efectivo_real),
        diferencia,
        estado_diferencia: diferencia > 0 ? "sobrante" : diferencia < 0 ? "faltante" : "exacta"
      };
    });

    const resumen = cierres.reduce((acc, c) => {
      acc.cantidad_cierres += 1;
      acc.total_esperado = n2(acc.total_esperado + Number(c.caja_esperada || 0));
      acc.total_real = n2(acc.total_real + Number(c.efectivo_real || 0));
      acc.total_diferencia = n2(acc.total_diferencia + Number(c.diferencia || 0));
      if (Number(c.diferencia || 0) < 0) acc.total_faltantes = n2(acc.total_faltantes + Math.abs(Number(c.diferencia)));
      if (Number(c.diferencia || 0) > 0) acc.total_sobrantes = n2(acc.total_sobrantes + Number(c.diferencia));
      return acc;
    }, {
      cantidad_cierres: 0,
      total_esperado: 0,
      total_real: 0,
      total_diferencia: 0,
      total_faltantes: 0,
      total_sobrantes: 0
    });

    res.json({ resumen, cierres });
  } catch (error) {
    console.error("Error reporte cajeros:", error);
    res.status(500).json({ error: "Error al obtener reporte de cajeros" });
  }
});

router.get("/reportes/caja/:caja_sesion_id", async (req, res) => {
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

    const detalleCaja = await calcularResumenCaja(pool, caja_sesion_id);

    const movimientosResult = await pool.query(
      `
      SELECT cm.*, e.nombre AS empleado_nombre
      FROM caja_movimientos cm
      LEFT JOIN empleados e ON e.id = cm.empleado_id
      WHERE cm.caja_sesion_id = $1
      ORDER BY cm.id ASC
      `,
      [caja_sesion_id]
    );

    res.json({
      caja: detalleCaja?.caja || cajaResult.rows[0],
      resumen: detalleCaja?.resumen || {},
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
router.get("/dashboard/inicio-pro", async (req, res) => {
  try {
    const fechaLocal = "((fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";

    const resumenResult = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN ${fechaLocal} = ${SQL_HOY_ARGENTINA} THEN total ELSE 0 END), 0) AS ventas_hoy,
        COALESCE(COUNT(*) FILTER (WHERE ${fechaLocal} = ${SQL_HOY_ARGENTINA}), 0) AS cantidad_ventas_hoy,
        COALESCE(SUM(CASE WHEN ${fechaLocal} >= DATE_TRUNC('month', ${SQL_HOY_ARGENTINA})::date
                           AND ${fechaLocal} < (DATE_TRUNC('month', ${SQL_HOY_ARGENTINA}) + INTERVAL '1 month')::date THEN total ELSE 0 END), 0) AS ventas_mes,
        COALESCE(SUM(CASE WHEN ${fechaLocal} = (${SQL_HOY_ARGENTINA} - INTERVAL '1 day')::date THEN total ELSE 0 END), 0) AS ventas_ayer,
        COALESCE(SUM(CASE WHEN ${fechaLocal} >= (DATE_TRUNC('month', ${SQL_HOY_ARGENTINA}) - INTERVAL '1 month')::date
                           AND ${fechaLocal} < DATE_TRUNC('month', ${SQL_HOY_ARGENTINA})::date THEN total ELSE 0 END), 0) AS ventas_mes_anterior
      FROM ventas
    `);

    const topProductosResult = await pool.query(`
      SELECT
        p.nombre,
        COALESCE(SUM(vd.cantidad), 0) AS cantidad_vendida,
        COALESCE(SUM(vd.subtotal), 0) AS total_vendido
      FROM ventas_detalle vd
      INNER JOIN productos p ON p.id = vd.producto_id
      INNER JOIN ventas v ON v.id = vd.venta_id
      WHERE ${fechaLocal} >= (${SQL_HOY_ARGENTINA} - INTERVAL '30 days')::date
      GROUP BY p.id, p.nombre
      ORDER BY total_vendido DESC, cantidad_vendida DESC, p.nombre ASC
      LIMIT 10
    `);

    const ventas7DiasResult = await pool.query(`
      SELECT
        TO_CHAR(d.dia, 'DD/MM') AS dia,
        d.dia AS fecha_real,
        COALESCE(SUM(v.total), 0) AS total
      FROM GENERATE_SERIES(
        (${SQL_HOY_ARGENTINA} - INTERVAL '6 days')::date,
        ${SQL_HOY_ARGENTINA},
        INTERVAL '1 day'
      ) d(dia)
      LEFT JOIN ventas v ON ${fechaLocal} = d.dia
      GROUP BY d.dia
      ORDER BY d.dia ASC
    `);

    const ventasFormaPagoResult = await pool.query(`
      SELECT
        COALESCE(forma_pago, 'sin_dato') AS forma_pago,
        COUNT(*) AS cantidad_ventas,
        COALESCE(SUM(total), 0) AS total
      FROM ventas
      WHERE ${fechaLocal} = ${SQL_HOY_ARGENTINA}
      GROUP BY COALESCE(forma_pago, 'sin_dato')
      ORDER BY total DESC
    `);

    const ventasEmpleadoResult = await pool.query(`
      SELECT
        COALESCE(e.nombre, 'Sin empleado') AS nombre,
        COUNT(v.id) AS cantidad_ventas,
        COALESCE(SUM(v.total), 0) AS total_vendido
      FROM ventas v
      LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE ${fechaLocal} >= (${SQL_HOY_ARGENTINA} - INTERVAL '30 days')::date
      GROUP BY e.id, e.nombre
      ORDER BY total_vendido DESC, cantidad_ventas DESC
      LIMIT 10
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
      ORDER BY (stock_actual - stock_minimo) ASC, nombre ASC
      LIMIT 10
    `);

    const clientesDeudoresResult = await pool.query(`
      SELECT
        c.nombre,
        c.telefono,
        COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) AS saldo
      FROM clientes c
      LEFT JOIN cuenta_corriente_movimientos m ON m.cliente_id = c.id
      WHERE c.activo = true
      GROUP BY c.id, c.nombre, c.telefono
      HAVING COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) > 0
      ORDER BY saldo DESC, c.nombre ASC
      LIMIT 10
    `);

    const deudaClientesResult = await pool.query(`
      SELECT COALESCE(SUM(saldo), 0) AS deuda_total
      FROM (
        SELECT COALESCE(SUM(CASE WHEN m.tipo = 'deuda' THEN m.monto ELSE -m.monto END), 0) AS saldo
        FROM clientes c
        LEFT JOIN cuenta_corriente_movimientos m ON m.cliente_id = c.id
        WHERE c.activo = true
        GROUP BY c.id
      ) x
      WHERE saldo > 0
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
      alertas.push(`Hay ${stockBajoResult.rows.length} productos con stock bajo o crítico.`);
    }

    if (clientesDeudoresResult.rows.length > 0) {
      alertas.push(`Hay ${clientesDeudoresResult.rows.length} clientes con deuda en cuenta corriente.`);
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
        ventas_mes: Number(resumen.ventas_mes || 0),
        deuda_clientes: Number(deudaClientesResult.rows[0]?.deuda_total || 0),
        caja_abierta: cajaAbierta,
        productos_bajo_stock: stockBajoResult.rows.length
      },
      comparativo: {
        ventas_hoy: Number(resumen.ventas_hoy || 0),
        ventas_ayer: Number(resumen.ventas_ayer || 0),
        ventas_mes: Number(resumen.ventas_mes || 0),
        ventas_mes_anterior: Number(resumen.ventas_mes_anterior || 0)
      },
      ventas_7_dias: ventas7DiasResult.rows.map(r => ({
        dia: r.dia,
        total: Number(r.total || 0)
      })),
      ventas_forma_pago: ventasFormaPagoResult.rows.map(r => ({
        forma_pago: r.forma_pago,
        cantidad_ventas: Number(r.cantidad_ventas || 0),
        total: Number(r.total || 0)
      })),
      ventas_empleado: ventasEmpleadoResult.rows.map(r => ({
        nombre: r.nombre,
        cantidad_ventas: Number(r.cantidad_ventas || 0),
        total_vendido: Number(r.total_vendido || 0)
      })),
      clientes_deudores: clientesDeudoresResult.rows.map(r => ({
        nombre: r.nombre,
        telefono: r.telefono || "",
        saldo: Number(r.saldo || 0)
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




  return router;
};
