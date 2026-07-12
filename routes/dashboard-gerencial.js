const express = require("express");

module.exports = function crearDashboardGerencialRouter({ pool, n2 }) {
  const router = express.Router();
  const fechaVenta = "((v.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const fechaCompra = "((COALESCE(c.fecha, c.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const fechaMovimiento = "((cm.fecha AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)";
  const hoy = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date";

  router.get("/dashboard/gerencial", async (req, res) => {
    try {
      const [ventas, compras, gastos, rentabilidad, ventas12m, compras6m, categorias, productos, empleados, proveedores, alertasStock] = await Promise.all([
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN ${fechaVenta} = ${hoy} THEN v.total ELSE 0 END),0) AS ventas_hoy,
            COUNT(*) FILTER (WHERE ${fechaVenta} = ${hoy})::int AS tickets_hoy,
            COALESCE(SUM(CASE WHEN ${fechaVenta} = (${hoy} - INTERVAL '1 day')::date THEN v.total ELSE 0 END),0) AS ventas_ayer,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= date_trunc('month', ${hoy})::date THEN v.total ELSE 0 END),0) AS ventas_mes,
            COALESCE(SUM(CASE WHEN ${fechaVenta} >= (date_trunc('month', ${hoy}) - INTERVAL '1 month')::date
                              AND ${fechaVenta} < date_trunc('month', ${hoy})::date THEN v.total ELSE 0 END),0) AS ventas_mes_anterior
          FROM ventas v
        `),
        pool.query(`
          SELECT COALESCE(SUM(cd.subtotal),0) AS compras_mes
          FROM compras c
          LEFT JOIN compras_detalle cd ON cd.compra_id = c.id
          WHERE ${fechaCompra} >= date_trunc('month', ${hoy})::date
        `).catch(() => ({ rows: [{ compras_mes: 0 }] })),
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN cm.tipo = 'retiro' AND cm.tipo_retiro IN ('gasto_negocio','pago_proveedor','otro') THEN cm.monto ELSE 0 END),0) AS gastos_mes,
            COALESCE(SUM(CASE WHEN cm.tipo = 'retiro' AND cm.tipo_retiro IN ('sueldo_empleado','adelanto_empleado') THEN cm.monto ELSE 0 END),0) AS sueldos_mes
          FROM caja_movimientos cm
          WHERE ${fechaMovimiento} >= date_trunc('month', ${hoy})::date
        `),
        pool.query(`
          SELECT COALESCE(SUM(
            vd.subtotal - (vd.cantidad * (COALESCE(p.costo,0) / NULLIF(COALESCE(p.cantidad_bulto,1),0)))
          ),0) AS ganancia_estimada_mes
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id = vd.venta_id
          LEFT JOIN productos p ON p.id = vd.producto_id
          WHERE ${fechaVenta} >= date_trunc('month', ${hoy})::date
        `),
        pool.query(`
          SELECT TO_CHAR(m.mes, 'MM/YYYY') AS etiqueta, m.mes,
                 COALESCE(SUM(v.total),0) AS total
          FROM generate_series(
            date_trunc('month', ${hoy}) - interval '11 months',
            date_trunc('month', ${hoy}), interval '1 month'
          ) m(mes)
          LEFT JOIN ventas v ON date_trunc('month', ${fechaVenta}) = m.mes
          GROUP BY m.mes ORDER BY m.mes
        `),
        pool.query(`
          SELECT TO_CHAR(m.mes, 'MM/YYYY') AS etiqueta, m.mes,
                 COALESCE((SELECT SUM(v.total) FROM ventas v WHERE date_trunc('month', ${fechaVenta}) = m.mes),0) AS ventas,
                 COALESCE((SELECT SUM(cd.subtotal) FROM compras c LEFT JOIN compras_detalle cd ON cd.compra_id=c.id WHERE date_trunc('month', ${fechaCompra}) = m.mes),0) AS compras
          FROM generate_series(
            date_trunc('month', ${hoy}) - interval '5 months',
            date_trunc('month', ${hoy}), interval '1 month'
          ) m(mes)
          ORDER BY m.mes
        `).catch(() => ({ rows: [] })),
        pool.query(`
          SELECT COALESCE(cat.nombre,'Sin categoría') AS nombre,
                 COALESCE(SUM(vd.subtotal),0) AS total,
                 COALESCE(SUM(vd.cantidad),0) AS cantidad
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id=vd.venta_id
          LEFT JOIN productos p ON p.id=vd.producto_id
          LEFT JOIN categorias cat ON cat.id=p.categoria_id
          WHERE ${fechaVenta} >= date_trunc('month', ${hoy})::date
          GROUP BY cat.nombre ORDER BY total DESC LIMIT 10
        `),
        pool.query(`
          SELECT p.nombre, COALESCE(SUM(vd.cantidad),0) AS cantidad,
                 COALESCE(SUM(vd.subtotal),0) AS total
          FROM ventas_detalle vd
          INNER JOIN ventas v ON v.id=vd.venta_id
          LEFT JOIN productos p ON p.id=vd.producto_id
          WHERE ${fechaVenta} >= date_trunc('month', ${hoy})::date
          GROUP BY p.id,p.nombre ORDER BY total DESC LIMIT 10
        `),
        pool.query(`
          SELECT COALESCE(e.nombre,'Sin empleado') AS nombre,
                 COUNT(v.id)::int AS tickets, COALESCE(SUM(v.total),0) AS total
          FROM ventas v LEFT JOIN empleados e ON e.id=v.empleado_id
          WHERE ${fechaVenta} >= date_trunc('month', ${hoy})::date
          GROUP BY e.id,e.nombre ORDER BY total DESC LIMIT 10
        `),
        pool.query(`
          SELECT COALESCE(pr.nombre,'Sin proveedor') AS nombre,
                 COUNT(DISTINCT c.id)::int AS compras,
                 COALESCE(SUM(cd.subtotal),0) AS total
          FROM compras c
          LEFT JOIN compras_detalle cd ON cd.compra_id=c.id
          LEFT JOIN proveedores pr ON pr.id=c.proveedor_id
          WHERE ${fechaCompra} >= date_trunc('month', ${hoy})::date
          GROUP BY pr.id,pr.nombre ORDER BY total DESC LIMIT 10
        `).catch(() => ({ rows: [] })),
        pool.query(`
          SELECT COUNT(*)::int AS cantidad
          FROM productos
          WHERE activo=true AND stock_actual <= stock_minimo
        `)
      ]);

      const v = ventas.rows[0] || {};
      const ventasHoy = Number(v.ventas_hoy || 0);
      const ticketsHoy = Number(v.tickets_hoy || 0);
      const ventasMes = Number(v.ventas_mes || 0);
      const ventasMesAnterior = Number(v.ventas_mes_anterior || 0);
      const comprasMes = Number(compras.rows[0]?.compras_mes || 0);
      const gastosMes = Number(gastos.rows[0]?.gastos_mes || 0);
      const sueldosMes = Number(gastos.rows[0]?.sueldos_mes || 0);
      const gananciaEstimada = Number(rentabilidad.rows[0]?.ganancia_estimada_mes || 0) - gastosMes - sueldosMes;

      const alertas = [];
      if (ventasMesAnterior > 0) {
        const variacion = ((ventasMes - ventasMesAnterior) / ventasMesAnterior) * 100;
        alertas.push({ tipo: variacion >= 0 ? 'ok' : 'peligro', texto: `Las ventas del mes ${variacion >= 0 ? 'subieron' : 'bajaron'} ${Math.abs(variacion).toFixed(1)}% respecto al mes anterior.` });
      }
      if (comprasMes > ventasMes && ventasMes > 0) alertas.push({ tipo: 'advertencia', texto: 'Las compras del mes superan las ventas registradas.' });
      const stockCritico = Number(alertasStock.rows[0]?.cantidad || 0);
      if (stockCritico > 0) alertas.push({ tipo: 'advertencia', texto: `Hay ${stockCritico} productos con stock bajo o sin stock.` });
      if (gananciaEstimada < 0) alertas.push({ tipo: 'peligro', texto: 'La rentabilidad estimada del mes es negativa después de gastos y sueldos.' });
      if (!alertas.length) alertas.push({ tipo: 'ok', texto: 'El negocio no presenta alertas gerenciales importantes.' });

      res.json({
        kpis: {
          ventas_hoy: n2(ventasHoy), tickets_hoy: ticketsHoy,
          promedio_ticket: ticketsHoy ? n2(ventasHoy / ticketsHoy) : 0,
          ventas_ayer: n2(v.ventas_ayer), ventas_mes: n2(ventasMes),
          ventas_mes_anterior: n2(ventasMesAnterior), compras_mes: n2(comprasMes),
          gastos_mes: n2(gastosMes), sueldos_mes: n2(sueldosMes),
          ganancia_estimada_mes: n2(gananciaEstimada), stock_critico: stockCritico
        },
        ventas_12_meses: ventas12m.rows.map(r => ({ etiqueta:r.etiqueta, total:n2(r.total) })),
        compras_vs_ventas: compras6m.rows.map(r => ({ etiqueta:r.etiqueta, ventas:n2(r.ventas), compras:n2(r.compras) })),
        categorias: categorias.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), cantidad:Number(r.cantidad||0) })),
        productos: productos.rows.map(r => ({ nombre:r.nombre||'Producto', total:n2(r.total), cantidad:Number(r.cantidad||0) })),
        empleados: empleados.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), tickets:Number(r.tickets||0) })),
        proveedores: proveedores.rows.map(r => ({ nombre:r.nombre, total:n2(r.total), compras:Number(r.compras||0) })),
        alertas
      });
    } catch (error) {
      console.error('Error dashboard gerencial:', error);
      res.status(500).json({ error: 'Error al cargar Dashboard Gerencial', detalle: error.message });
    }
  });

  return router;
};
