/** Fase 3.3 — pantalla de respaldo cuando no hay red.
 *  El service worker la usa como fallback de navegación. Sin datos: si no
 *  hay red, mostrar datos viejos sería peor que decir la verdad. */

export default function OfflinePage() {
  return (
    <main className="mShell">
      <header className="mHeader">
        <div>
          <span className="mBrand">Consenso IA</span>
          <h1>Sin conexión</h1>
        </div>
      </header>
      <section className="mSection">
        <p className="mNotice">
          Esta pantalla necesita red para mostrar el estado real de las tareas. Cuando vuelva la conexión,
          recargá y los datos se actualizan solos.
        </p>
        <p className="mEmpty">No se muestran datos guardados: una lista de tareas desactualizada puede inducir a error.</p>
      </section>
    </main>
  );
}
