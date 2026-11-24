'use client';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { filterPredecessorOptions, PREDECESSOR_OPTIONS_LIMIT, type PredecessorOption } from './lob-model';

/** Campo "adicionar predecessora" do painel do bloco (23/11/2026, pedido do Jorge): no lugar da
 * lista suspensa, um campo em que se digita parte do serviço ou do local e a lista abaixo fica só
 * com o que combina. Setas percorrem, Enter escolhe, Esc fecha. `value` é o id escolhido ('' sem
 * escolha); digitar depois de escolher desfaz a escolha. Para zerar o texto de fora, troque a `key`. */
export function PredecessorPicker({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: PredecessorOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = options.find(option => option.id === value);
  const matches = filterPredecessorOptions(options, selected ? '' : query);
  const shown = matches.slice(0, PREDECESSOR_OPTIONS_LIMIT);
  const hidden = matches.length - shown.length;
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  const choose = (option: PredecessorOption) => {
    onChange(option.id);
    setQuery(option.label);
    setOpen(false);
  };

  const move = (to: number) => {
    setActive(to);
    listRef.current?.children[to]?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return setOpen(true);
      if (shown.length) move((current + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (event.key === 'Enter' && open && shown[current]) {
      event.preventDefault();
      choose(shown[current]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-slate-400" />
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[current] ? `${listId}-${shown[current].id}` : undefined}
        autoComplete="off"
        className="field py-1 pr-2 pl-7 text-xs"
        placeholder={options.length ? 'buscar predecessora…' : 'nenhum bloco disponível'}
        title="Digite parte do nome do serviço ou do local para filtrar a lista"
        value={selected ? selected.label : query}
        disabled={disabled || !options.length}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={event => {
          if (value) onChange('');
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Blocos que podem ser predecessora"
          className="absolute top-full left-0 z-30 w-full min-w-72 mt-1 max-h-60 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg"
        >
          {shown.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${option.id}`}
              role="option"
              aria-selected={index === current}
              className={`cursor-pointer px-2.5 py-1.5 ${index === current ? 'bg-primary-soft text-slate-900' : 'text-slate-700'}`}
              // mousedown, e não click: o campo perde o foco antes do click e a lista fecharia.
              onMouseDown={event => {
                event.preventDefault();
                choose(option);
              }}
              onMouseEnter={() => setActive(index)}
            >
              {option.label}
            </li>
          ))}
          {!shown.length && <li className="px-2.5 py-1.5 text-slate-500">Nenhum bloco com esse texto.</li>}
          {hidden > 0 && (
            <li className="border-t border-slate-100 px-2.5 py-1.5 text-slate-500">
              Mais {hidden} {hidden === 1 ? 'bloco' : 'blocos'}: digite para refinar a busca.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
