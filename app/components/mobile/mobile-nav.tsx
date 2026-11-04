import Link from "next/link";
import { Activity, Home, ListChecks, Settings } from "lucide-react";

/**
 * Fase 3.2 — navegación inferior de la PWA.
 *
 * Fija abajo, con targets grandes (móvil first). Solo cinco destinos;
 * todo lo demás sigue siendo desktop.
 */

const ITEMS = [
  { key: "home", href: "/m", label: "Inicio", Icon: Home },
  { key: "tasks", href: "/m/tasks", label: "Tareas", Icon: ListChecks },
  { key: "new", href: "/m/tasks/new", label: "Nueva", Icon: ListChecks },
  { key: "runs", href: "/m/runs", label: "Corridas", Icon: Activity },
  { key: "settings", href: "/m/settings", label: "Ajustes", Icon: Settings },
] as const;

export function MobileNav({ active }: { active?: string }) {
  return (
    <nav className="mNav" aria-label="Navegación principal">
      {ITEMS.map(({ key, href, label, Icon }) => (
        <Link key={key} href={href} className={active === key ? "mNavItem active" : "mNavItem"}>
          <Icon size={20} />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
