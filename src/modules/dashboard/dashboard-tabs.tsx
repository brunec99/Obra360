import Link from 'next/link';

/** Abas do Dashboard geral (15/11/2026, regra 1 do modelo "Aba Acessos no Dashboard geral"): "Obras" é a tela de
 * sempre (`/dashboard`) e "Acessos" (`/dashboard/acessos`) mostra quem entrou no sistema, em quais módulos e por
 * quanto tempo. Só admin vê as abas (regra 2): quem chama decide e, para os demais, não desenha nada. Sem estado:
 * serve à tela do cliente e à página do servidor. */
export function DashboardTabs({ active }: { active: 'obras' | 'acessos' }) {
  const tab = (key: 'obras' | 'acessos', href: string, label: string, badge?: string) => {
    const on = key === active;
    return (
      <Link
        href={href}
        role="tab"
        aria-selected={on}
        aria-current={on ? 'page' : undefined}
        className={`-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors ${
          on ? 'border-primary text-primary-ink' : 'border-transparent text-slate-500 hover:text-slate-800'
        }`}
      >
        {label}
        {badge && (
          <span className="rounded-full border border-slate-200 bg-slate-100 px-1.5 text-[10px] font-bold text-slate-500">{badge}</span>
        )}
      </Link>
    );
  };
  return (
    <div
      data-tour="acessos-abas"
      role="tablist"
      aria-label="Abas do Dashboard geral"
      className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200"
    >
      {tab('obras', '/dashboard', 'Obras')}
      {tab('acessos', '/dashboard/acessos', 'Acessos', 'admin')}
    </div>
  );
}
