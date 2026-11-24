'use client';
import { useCallback, useId, type ReactNode } from 'react';
import { Camera, ImageOff, ImagePlus, LoaderCircle, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import {
  DAILY_EQUIPMENT_STATUS,
  DAILY_EQUIPMENT_STATUS_LABEL,
  DAILY_LIMITS,
  DAILY_SHIFT_DEFAULT,
  DAILY_SHIFT_KEYS,
  DAILY_SHIFT_LABEL,
  DAILY_UNITS,
  DAILY_WEATHER_KEYS,
  DAILY_WEATHER_LABEL,
  type DailyCrew,
  type DailyEquipment,
  type DailyEvent,
  type DailyLocal,
  type DailyShift,
  type DailySupport,
  type DailyTask,
  type DailyWeather,
  type SiengeOption,
} from '@/domain/daily-report';
import { formatDay, HEADCOUNT_LIMITS } from '@/domain/headcount';
import { crewTotals, type DiaryPhoto, type PhotoFields } from './diary-model';
import { readThumb } from './offline-store';

/* As seções do formulário do Diário de Obra, na ordem do protótipo aprovado. Cada uma recebe o valor e
 * devolve o valor novo; quem guarda, grava no aparelho e sincroniza é o editor (`diary-editor.tsx`).
 * Pensadas para o celular: uma coluna, alvos de toque de 2,75 rem, letra de 16 px nos campos (o iPhone
 * amplia a tela em campo com letra menor). */

export const inputClass = 'field min-h-11 min-w-0 text-base disabled:bg-slate-50 disabled:text-slate-500 sm:text-sm';
const removeClass =
  'grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-danger transition-colors hover:bg-danger-soft disabled:opacity-40';
const addClass = 'button-ghost min-h-11';
const rowClass = 'grid gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3';

const parseNumber = (text: string): number | null => {
  if (!text.trim()) return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

export function Section({
  id,
  title,
  note,
  tourId,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  tourId?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} data-tour={tourId} aria-labelledby={`${id}-titulo`} className="panel grid min-w-0 scroll-mt-32 grid-cols-1 gap-3 p-4">
      <h2 id={`${id}-titulo`} className="flex flex-wrap items-baseline gap-x-2 text-base font-bold text-slate-900">
        {title}
        {note && <span className="text-xs font-medium text-slate-500">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Hint({ tone = 'muted', children }: { tone?: 'muted' | 'warning' | 'danger'; children: ReactNode }) {
  const color = tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-slate-500';
  return <p className={`text-xs leading-5 ${color}`}>{children}</p>;
}

export function Label({ text, children, className = '' }: { text: string; children: ReactNode; className?: string }) {
  return (
    <label className={`grid min-w-0 gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${className}`}>
      {text}
      {children}
    </label>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  tone,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  tone?: (value: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(option => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`min-h-11 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${
              pressed
                ? `${tone?.(option.value) ?? 'border-primary bg-primary'} text-white`
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" className={removeClass} aria-label={label} onClick={onClick} disabled={disabled}>
      <X size={18} aria-hidden />
    </button>
  );
}

const replaceAt = <T,>(list: readonly T[], index: number, fields: Partial<T>): T[] =>
  list.map((item, current) => (current === index ? { ...item, ...fields } : item));
const removeAt = <T,>(list: readonly T[], index: number): T[] => list.filter((_, current) => current !== index);

/* ---------- Clima e jornada ---------- */

const WEATHER_OPTIONS = DAILY_WEATHER_KEYS.map(value => ({ value, label: DAILY_WEATHER_LABEL[value] }));
const weatherTone = (weather: DailyWeather) =>
  weather === 'fine' ? 'border-primary bg-primary' : weather === 'unworkable' ? 'border-danger bg-danger' : 'border-warning bg-warning';

export function ShiftsSection({
  shifts,
  rainfall,
  problems,
  disabled,
  onShifts,
  onRainfall,
}: {
  shifts: DailyShift[];
  rainfall: number | null;
  problems: string[];
  disabled: boolean;
  onShifts: (shifts: DailyShift[]) => void;
  onRainfall: (rainfall: number | null) => void;
}) {
  const patch = (key: DailyShift['key'], fields: Partial<DailyShift>) =>
    onShifts(shifts.map(shift => (shift.key === key ? { ...shift, ...fields } : shift)));
  return (
    <Section id="diario-clima" tourId="diario-turnos" title="Clima e jornada" note="pelo menos um turno">
      <div className="grid gap-3">
        {DAILY_SHIFT_KEYS.map((key, index) => {
          const shift = shifts.find(item => item.key === key);
          const name = DAILY_SHIFT_LABEL[key];
          return (
            <div key={key} className={`grid gap-2 ${index ? 'border-t border-slate-100 pt-3' : ''}`}>
              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--color-primary)]"
                  checked={!!shift}
                  disabled={disabled}
                  onChange={event =>
                    onShifts(
                      event.target.checked
                        ? [...shifts, { key, ...DAILY_SHIFT_DEFAULT[key], weather: 'fine' }]
                        : shifts.filter(item => item.key !== key),
                    )
                  }
                />
                {name}
              </label>
              {shift && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Label text="Início">
                      <input
                        type="time"
                        className={inputClass}
                        value={shift.startTime}
                        disabled={disabled}
                        onChange={event => patch(key, { startTime: event.target.value })}
                      />
                    </Label>
                    <Label text="Fim">
                      <input
                        type="time"
                        className={inputClass}
                        value={shift.finishTime}
                        disabled={disabled}
                        onChange={event => patch(key, { finishTime: event.target.value })}
                      />
                    </Label>
                  </div>
                  <Segmented
                    label={`Clima da ${name.toLowerCase()}`}
                    options={WEATHER_OPTIONS}
                    value={shift.weather}
                    disabled={disabled}
                    tone={weatherTone}
                    onChange={weather => patch(key, { weather })}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      {problems.map(problem => (
        <Hint key={problem} tone="danger">
          {problem} O rascunho fica no aparelho até você corrigir.
        </Hint>
      ))}
      {shifts.length === 0 && <Hint tone="warning">Marque pelo menos um turno: o Sienge não aceita diário sem turno.</Hint>}
      <Label text="Índice pluviométrico (mm)">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={DAILY_LIMITS.rainfallMax - 0.01}
          step={0.1}
          className={inputClass}
          value={rainfall ?? ''}
          disabled={disabled}
          onChange={event => onRainfall(parseNumber(event.target.value))}
        />
      </Label>
    </Section>
  );
}

/* ---------- Atividades ---------- */

type Commitment = DailySupport['commitments'][number];

function LocalSelect({
  value,
  locals,
  disabled,
  label,
  onChange,
}: {
  value: string | null;
  locals: DailyLocal[];
  disabled: boolean;
  label?: string;
  onChange: (localId: string | null) => void;
}) {
  return (
    <select
      className={inputClass}
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={event => onChange(event.target.value || null)}
    >
      <option value="">Sem local</option>
      {locals.map(local => (
        <option key={local.id} value={local.id}>
          {local.name}
        </option>
      ))}
    </select>
  );
}

export function TasksSection({
  tasks,
  commitments,
  locals,
  disabled,
  onChange,
}: {
  tasks: DailyTask[];
  commitments: Commitment[];
  locals: DailyLocal[];
  disabled: boolean;
  onChange: (tasks: DailyTask[]) => void;
}) {
  const used = new Set(tasks.map(task => task.commitmentId).filter(Boolean));
  const suggestions = commitments.filter(commitment => !used.has(commitment.id));
  const localName = (id: string | null) => locals.find(local => local.id === id)?.name;
  const full = tasks.length >= DAILY_LIMITS.tasks;
  const add = (task: Omit<DailyTask, 'id'>) => onChange([...tasks, { id: crypto.randomUUID(), ...task }]);
  const blank = { description: '', quantity: null, unit: '', localId: null, notes: '', commitmentId: null };
  return (
    <Section id="diario-atividades" title="Atividades" note={`${tasks.length} no dia`}>
      {!disabled && suggestions.length > 0 && (
        <>
          <Hint>Do curto prazo desta semana (toque para trazer):</Hint>
          <div className="grid gap-1.5">
            {suggestions.map(commitment => (
              <button
                key={commitment.id}
                type="button"
                disabled={full}
                onClick={() =>
                  add({
                    ...blank,
                    description: commitment.name.slice(0, DAILY_LIMITS.taskDescription),
                    localId: commitment.localId,
                    commitmentId: commitment.id,
                  })
                }
                className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-primary-soft disabled:opacity-50"
              >
                <Plus size={16} className="shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  {commitment.name}
                  {localName(commitment.localId) ? ` · ${localName(commitment.localId)}` : ''}
                </span>
                {commitment.supplier && <span className="shrink-0 text-xs text-slate-500">{commitment.supplier}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {tasks.length > 0 && (
        <div className="grid gap-2.5">
          {tasks.map((task, index) => (
            <div key={task.id} className={rowClass}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-xs font-semibold text-slate-500">Atividade {index + 1}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                    task.commitmentId
                      ? 'border-primary-ring bg-primary-soft text-primary-strong'
                      : 'border-warning-ring bg-warning-soft text-warning'
                  }`}
                >
                  {task.commitmentId ? 'Curto prazo' : 'Avulsa'}
                </span>
                <RemoveButton
                  label={`Remover a atividade ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(removeAt(tasks, index))}
                />
              </div>
              <input
                type="text"
                className={inputClass}
                maxLength={DAILY_LIMITS.taskDescription}
                placeholder="O que foi feito"
                aria-label={`Descrição da atividade ${index + 1}`}
                value={task.description}
                disabled={disabled}
                onChange={event => onChange(replaceAt(tasks, index, { description: event.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1.4fr_0.8fr_0.8fr]">
                <Label text="Local" className="col-span-2 sm:col-span-1">
                  <LocalSelect
                    value={task.localId}
                    locals={locals}
                    disabled={disabled}
                    onChange={localId => onChange(replaceAt(tasks, index, { localId }))}
                  />
                </Label>
                <Label text="Quant.">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    className={inputClass}
                    value={task.quantity ?? ''}
                    disabled={disabled}
                    onChange={event => onChange(replaceAt(tasks, index, { quantity: parseNumber(event.target.value) }))}
                  />
                </Label>
                <Label text="Unidade">
                  <select
                    className={inputClass}
                    value={task.unit}
                    disabled={disabled}
                    onChange={event => onChange(replaceAt(tasks, index, { unit: event.target.value }))}
                  >
                    {DAILY_UNITS.map(unit => (
                      <option key={unit} value={unit}>
                        {unit || 'Sem unidade'}
                      </option>
                    ))}
                  </select>
                </Label>
              </div>
              <input
                type="text"
                className={inputClass}
                maxLength={DAILY_LIMITS.taskNotes}
                placeholder="Observação (opcional)"
                aria-label={`Observação da atividade ${index + 1}`}
                value={task.notes}
                disabled={disabled}
                onChange={event => onChange(replaceAt(tasks, index, { notes: event.target.value }))}
              />
            </div>
          ))}
        </div>
      )}
      {tasks.length === 0 && disabled && <Hint>Nenhuma atividade no dia.</Hint>}
      {!disabled && (
        <div>
          <button type="button" className={addClass} disabled={full} onClick={() => add(blank)}>
            <Plus size={16} aria-hidden /> Atividade avulsa
          </button>
        </div>
      )}
      <Hint>As atividades do curto prazo entram no Sienge como tarefa avulsa, com descrição, quantidade e local.</Hint>
    </Section>
  );
}

/* ---------- Mão de obra ---------- */

export function CrewsSection({
  crews,
  lastCrews,
  companies,
  roles,
  disabled,
  onChange,
}: {
  crews: DailyCrew[];
  lastCrews: { date: string; crews: DailyCrew[] } | null;
  companies: string[];
  roles: string[];
  disabled: boolean;
  onChange: (crews: DailyCrew[]) => void;
}) {
  const listId = useId();
  const totals = crewTotals(crews);
  const full = crews.length >= DAILY_LIMITS.crews;
  return (
    <Section
      id="diario-mao-de-obra"
      tourId="diario-mao-de-obra"
      title="Mão de obra"
      note={`${totals.people} ${totals.people === 1 ? 'pessoa' : 'pessoas'}`}
    >
      <Hint>
        Um lançamento só: o que você lança aqui aparece no Histograma (2.2), e o que foi lançado lá aparece aqui. Ao Sienge vai uma linha
        por empresa, com o total de pessoas.
      </Hint>
      {!disabled && lastCrews && lastCrews.crews.length > 0 && (
        <div>
          <button type="button" className="button-ghost min-h-11" onClick={() => onChange(lastCrews.crews.map(crew => ({ ...crew })))}>
            <RotateCcw size={16} aria-hidden /> Repetir o último dia ({formatDay(lastCrews.date, false)})
          </button>
        </div>
      )}
      {crews.length > 0 && (
        <div className="grid gap-2">
          {crews.map((crew, index) => (
            <div
              key={index}
              className={`${rowClass} grid-cols-[minmax(0,1fr)_4.5rem_auto] items-end sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_4.5rem_auto]`}
            >
              <Label text="Empresa" className="col-span-3 sm:col-span-1">
                <input
                  type="text"
                  className={inputClass}
                  list={`${listId}-empresas`}
                  maxLength={HEADCOUNT_LIMITS.name}
                  value={crew.company}
                  disabled={disabled}
                  onChange={event => onChange(replaceAt(crews, index, { company: event.target.value }))}
                />
              </Label>
              <Label text="Função">
                <input
                  type="text"
                  className={inputClass}
                  list={`${listId}-funcoes`}
                  maxLength={HEADCOUNT_LIMITS.name}
                  value={crew.role}
                  disabled={disabled}
                  onChange={event => onChange(replaceAt(crews, index, { role: event.target.value }))}
                />
              </Label>
              <Label text="Qtd.">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={HEADCOUNT_LIMITS.quantity}
                  step={1}
                  className={inputClass}
                  value={crew.quantity || ''}
                  disabled={disabled}
                  onChange={event => onChange(replaceAt(crews, index, { quantity: Math.trunc(parseNumber(event.target.value) ?? 0) }))}
                />
              </Label>
              <RemoveButton
                label={`Remover ${crew.role || 'a linha'} ${crew.company ? `da ${crew.company}` : index + 1}`}
                disabled={disabled}
                onClick={() => onChange(removeAt(crews, index))}
              />
            </div>
          ))}
        </div>
      )}
      {crews.length === 0 && <Hint>Nenhuma equipe lançada neste dia.</Hint>}
      <datalist id={`${listId}-empresas`}>
        {companies.map(company => (
          <option key={company} value={company} />
        ))}
      </datalist>
      <datalist id={`${listId}-funcoes`}>
        {roles.map(role => (
          <option key={role} value={role} />
        ))}
      </datalist>
      {!disabled && (
        <div>
          <button
            type="button"
            className={addClass}
            disabled={full}
            onClick={() => onChange([...crews, { company: '', role: '', quantity: 1 }])}
          >
            <Plus size={16} aria-hidden /> Equipe
          </button>
        </div>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums text-slate-500">
        <span>
          Próprio <b className="text-slate-900">{totals.own}</b>
        </span>
        <span>
          Empreiteiros <b className="text-slate-900">{totals.contractors}</b>
        </span>
        <span>
          Empresas <b className="text-slate-900">{totals.companies}</b>
        </span>
      </p>
    </Section>
  );
}

/* ---------- Equipamentos e ocorrências ---------- */

const STATUS_OPTIONS = DAILY_EQUIPMENT_STATUS.map(value => ({ value, label: DAILY_EQUIPMENT_STATUS_LABEL[value] }));

/** As opções do Sienge mais a do item, se ela saiu da lista (o rótulo guardado no lançamento continua valendo). */
function TypeSelect({
  value,
  label,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: number;
  label: string;
  options: SiengeOption[];
  disabled: boolean;
  ariaLabel: string;
  onChange: (option: SiengeOption) => void;
}) {
  const known = options.some(option => option.id === value);
  return (
    <select
      className={`${inputClass} flex-1`}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={event => {
        const option = options.find(item => item.id === Number(event.target.value));
        if (option) onChange(option);
      }}
    >
      {!known && <option value={value}>{label || 'Escolha o tipo'}</option>}
      {options.map(option => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const NO_TYPES = 'Os tipos vêm do Sienge e não foram carregados. Abra o diário com sinal para lançar.';

export function EquipmentsSection({
  equipments,
  types,
  disabled,
  onChange,
}: {
  equipments: DailyEquipment[];
  types: SiengeOption[];
  disabled: boolean;
  onChange: (equipments: DailyEquipment[]) => void;
}) {
  return (
    <Section id="diario-equipamentos" title="Equipamentos" note={`${equipments.length} no dia`}>
      {equipments.map((equipment, index) => (
        <div key={equipment.id} className={rowClass}>
          <div className="flex items-center gap-2">
            <TypeSelect
              value={equipment.typeId}
              label={equipment.typeLabel}
              options={types}
              disabled={disabled}
              ariaLabel={`Tipo do equipamento ${index + 1}`}
              onChange={option => onChange(replaceAt(equipments, index, { typeId: option.id, typeLabel: option.label }))}
            />
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={DAILY_LIMITS.equipmentQuantity}
              step={1}
              className={`${inputClass} w-[4.5rem] shrink-0`}
              aria-label={`Quantidade do equipamento ${index + 1}`}
              value={equipment.quantity || ''}
              disabled={disabled}
              onChange={event => onChange(replaceAt(equipments, index, { quantity: Math.trunc(parseNumber(event.target.value) ?? 0) }))}
            />
            <RemoveButton
              label={`Remover o equipamento ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(removeAt(equipments, index))}
            />
          </div>
          <Segmented
            label={`Situação do equipamento ${index + 1}`}
            options={STATUS_OPTIONS}
            value={equipment.status}
            disabled={disabled}
            onChange={status => onChange(replaceAt(equipments, index, { status }))}
          />
        </div>
      ))}
      {equipments.length === 0 && <Hint>Nenhum equipamento no dia.</Hint>}
      {!disabled &&
        (types.length === 0 ? (
          <Hint tone="warning">{NO_TYPES}</Hint>
        ) : (
          <div>
            <button
              type="button"
              className={addClass}
              disabled={equipments.length >= DAILY_LIMITS.equipments}
              onClick={() =>
                onChange([
                  ...equipments,
                  { id: crypto.randomUUID(), typeId: types[0].id, typeLabel: types[0].label, quantity: 1, status: 'in_use' },
                ])
              }
            >
              <Plus size={16} aria-hidden /> Equipamento
            </button>
          </div>
        ))}
    </Section>
  );
}

export function EventsSection({
  events,
  types,
  disabled,
  onChange,
}: {
  events: DailyEvent[];
  types: SiengeOption[];
  disabled: boolean;
  onChange: (events: DailyEvent[]) => void;
}) {
  return (
    <Section id="diario-ocorrencias" title="Ocorrências" note={`${events.length} no dia`}>
      {events.map((event, index) => (
        <div key={event.id} className={rowClass}>
          <div className="flex items-center gap-2">
            <TypeSelect
              value={event.typeId}
              label={event.typeLabel}
              options={types}
              disabled={disabled}
              ariaLabel={`Tipo da ocorrência ${index + 1}`}
              onChange={option => onChange(replaceAt(events, index, { typeId: option.id, typeLabel: option.label }))}
            />
            <RemoveButton
              label={`Remover a ocorrência ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(removeAt(events, index))}
            />
          </div>
          <textarea
            className={`${inputClass} min-h-20`}
            maxLength={DAILY_LIMITS.eventDescription}
            placeholder="O que aconteceu"
            aria-label={`Descrição da ocorrência ${index + 1}`}
            value={event.description}
            disabled={disabled}
            onChange={change => onChange(replaceAt(events, index, { description: change.target.value }))}
          />
          {!disabled && !event.description.trim() && <Hint tone="warning">Sem descrição, a ocorrência não é gravada.</Hint>}
        </div>
      ))}
      {events.length === 0 && <Hint>Nenhuma ocorrência no dia.</Hint>}
      {!disabled &&
        (types.length === 0 ? (
          <Hint tone="warning">{NO_TYPES}</Hint>
        ) : (
          <div>
            <button
              type="button"
              className={addClass}
              disabled={events.length >= DAILY_LIMITS.events}
              onClick={() =>
                onChange([...events, { id: crypto.randomUUID(), typeId: types[0].id, typeLabel: types[0].label, description: '' }])
              }
            >
              <Plus size={16} aria-hidden /> Ocorrência
            </button>
          </div>
        ))}
    </Section>
  );
}

export function NotesSection({ notes, disabled, onChange }: { notes: string; disabled: boolean; onChange: (notes: string) => void }) {
  return (
    <Section id="diario-observacoes" title="Observações" note={`${notes.length} de ${DAILY_LIMITS.notes}`}>
      <textarea
        className={`${inputClass} min-h-28`}
        maxLength={DAILY_LIMITS.notes}
        aria-label="Observações do dia"
        value={notes}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    </Section>
  );
}

/* ---------- Fotos ---------- */

/** Miniatura de uma foto do diário: a que está guardada no aparelho (foto na fila, ou já enviada) e, sem ela,
 * a URL assinada. Sem estado: a URL local é criada ao montar e liberada quando o elemento sai. */
export function DiaryThumb({ photo, className = '' }: { photo: Pick<DiaryPhoto, 'id' | 'thumbUrl' | 'url'>; className?: string }) {
  const remote = photo.thumbUrl ?? photo.url;
  const ref = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      let local: string | undefined;
      let active = true;
      void readThumb(photo.id).then(blob => {
        if (!active) return;
        if (blob) {
          local = URL.createObjectURL(blob);
          image.src = local;
        } else if (remote) image.src = remote;
      });
      return () => {
        active = false;
        if (local) URL.revokeObjectURL(local);
      };
    },
    [photo.id, remote],
  );
  return (
    <span
      className={`relative grid place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-slate-400 ${className}`}
    >
      <ImageOff size={20} aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element -- URL local (blob:) ou assinada do Storage, de vida curta */}
      <img ref={ref} alt="" className="absolute inset-0 h-full w-full object-cover [&:not([src])]:hidden" />
    </span>
  );
}

function PhotoStatus({ photo, reportSent }: { photo: DiaryPhoto; reportSent: boolean }) {
  const badge = 'rounded-full border px-2 py-0.5 text-[11px] font-semibold';
  if (photo.local)
    return (
      <span className={`${badge} border-warning-ring bg-warning-soft text-warning`}>
        {photo.held ? 'No aparelho · falta a descrição' : 'No aparelho · aguardando envio'}
      </span>
    );
  if (photo.siengeStatus === 'sent') return <span className={`${badge} border-success-ring bg-success-soft text-success`}>No Sienge</span>;
  if (photo.siengeStatus === 'error')
    return <span className={`${badge} border-danger-ring bg-danger-soft text-danger`}>O Sienge recusou</span>;
  if (reportSent) return <span className={`${badge} border-warning-ring bg-warning-soft text-warning`}>Falta enviar ao Sienge</span>;
  return null;
}

export function PhotosSection({
  photos,
  locals,
  canAdd,
  canEdit,
  reportSent,
  preparing,
  busyPhotoId,
  onAdd,
  onChange,
  onDelete,
  onRetry,
  onDiscard,
  onOpen,
}: {
  photos: DiaryPhoto[];
  locals: DailyLocal[];
  /** Pode juntar foto (vale também depois do envio). */
  canAdd: boolean;
  /** Pode alterar e excluir as fotos que ainda não foram ao Sienge. */
  canEdit: boolean;
  reportSent: boolean;
  /** Fotos sendo comprimidas agora. */
  preparing: { current: number; total: number } | null;
  /** Foto sendo enviada ao Sienge agora. */
  busyPhotoId: string | null;
  onAdd: (files: File[]) => void;
  onChange: (photo: DiaryPhoto, fields: PhotoFields) => void;
  onDelete: (photo: DiaryPhoto) => void;
  /** "Tentar de novo": a operação recusada (foto no aparelho) ou o envio ao Sienge. */
  onRetry: (photo: DiaryPhoto) => void;
  /** Desfaz a alteração recusada de uma foto que já subiu. */
  onDiscard: (photo: DiaryPhoto) => void;
  onOpen: (photo: DiaryPhoto) => void;
}) {
  const withLocal = photos.filter(photo => photo.localId !== null).length;
  const room = DAILY_LIMITS.photos - photos.length;
  const blocked = !canAdd || preparing !== null || room <= 0;
  const pick = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = ''; // permite escolher a mesma foto de novo
    if (files.length) onAdd(files);
  };
  const pickerClass = `button-ghost min-h-11 cursor-pointer ${blocked ? 'pointer-events-none opacity-50' : ''}`;
  const openWithKeyboard = (event: React.KeyboardEvent<HTMLLabelElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.currentTarget.querySelector('input')?.click();
  };
  return (
    <Section
      id="diario-fotos"
      tourId="diario-fotos"
      title="Fotos"
      note={photos.length ? `${withLocal} de ${photos.length} com local` : 'nenhuma no dia'}
    >
      <Hint>Foto sem local não entra no Relatório Fotográfico do Sienge.</Hint>
      {photos.length > 0 && (
        <div className="grid gap-2.5">
          {photos.map((photo, index) => {
            const locked = !canEdit || photo.siengeStatus === 'sent';
            const fields: PhotoFields = { description: photo.description, localId: photo.localId, showInReports: photo.showInReports };
            return (
              <div key={photo.id} className={`${rowClass} grid-cols-[5rem_minmax(0,1fr)] items-start`}>
                <button
                  type="button"
                  onClick={() => onOpen(photo)}
                  aria-label={`Ampliar a foto ${index + 1}`}
                  className="rounded-lg focus-visible:ring-2 focus-visible:ring-primary-ring focus-visible:outline-none"
                >
                  <DiaryThumb photo={photo} className="aspect-square w-20" />
                </button>
                <div className="grid min-w-0 gap-2">
                  <div className="flex items-start gap-2">
                    <textarea
                      rows={2}
                      className={`${inputClass} flex-1`}
                      maxLength={DAILY_LIMITS.photoDescription}
                      placeholder="Descrição da foto"
                      aria-label={`Descrição da foto ${index + 1}`}
                      value={photo.description}
                      disabled={locked}
                      onChange={event => onChange(photo, { ...fields, description: event.target.value })}
                    />
                    {!locked && (
                      <button
                        type="button"
                        className={removeClass}
                        aria-label={`Excluir a foto ${index + 1}`}
                        onClick={() => onDelete(photo)}
                      >
                        <Trash2 size={17} aria-hidden />
                      </button>
                    )}
                  </div>
                  <LocalSelect
                    value={photo.localId}
                    locals={locals}
                    disabled={locked}
                    label={`Local da foto ${index + 1}`}
                    onChange={localId => onChange(photo, { ...fields, localId })}
                  />
                  {photo.localId !== null ? (
                    <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-[var(--color-primary)]"
                        checked={photo.showInReports}
                        disabled={locked}
                        onChange={event => onChange(photo, { ...fields, showInReports: event.target.checked })}
                      />
                      Mostrar no Relatório Fotográfico
                    </label>
                  ) : (
                    <Hint tone="warning">Sem local, esta foto fica só como anexo do diário.</Hint>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <PhotoStatus photo={photo} reportSent={reportSent} />
                    {busyPhotoId === photo.id && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary-ink">
                        <LoaderCircle size={14} className="animate-spin" aria-hidden /> Enviando ao Sienge…
                      </span>
                    )}
                  </div>
                  {(photo.queueError || (photo.siengeStatus === 'error' && photo.siengeError)) && (
                    <div role="alert" className="grid gap-2 rounded-lg border border-danger-ring bg-danger-soft p-2 text-xs text-rose-800">
                      <span>{photo.queueError ?? photo.siengeError}</span>
                      {canAdd && (
                        <span className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="button-ghost min-h-10"
                            disabled={busyPhotoId !== null}
                            onClick={() => onRetry(photo)}
                          >
                            <RotateCcw size={14} aria-hidden /> Tentar de novo
                          </button>
                          {photo.queueError && (
                            <button type="button" className="button-ghost min-h-10" onClick={() => onDiscard(photo)}>
                              {photo.local ? 'Descartar a foto' : 'Desfazer a alteração'}
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {photos.length === 0 && !canAdd && <Hint>Nenhuma foto no dia.</Hint>}
      {canAdd && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Rótulo com o campo dentro (no iPhone, `click()` num campo escondido falha às vezes). O campo é `hidden`,
              e não `sr-only`: campo invisível de posição absoluta numa área que rola faz o documento rolar ao
              receber o foco, e a tela fica em branco (defeito de 23/11/2026). O teclado aciona pelo rótulo. */}
          <label
            className={`${pickerClass} hidden pointer-coarse:inline-flex`}
            tabIndex={blocked ? -1 : 0}
            role="button"
            aria-disabled={blocked}
            onKeyDown={openWithKeyboard}
          >
            <Camera size={18} aria-hidden /> Tirar foto
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              disabled={blocked}
              onChange={event => pick(event.currentTarget)}
            />
          </label>
          <label className={pickerClass} tabIndex={blocked ? -1 : 0} role="button" aria-disabled={blocked} onKeyDown={openWithKeyboard}>
            <ImagePlus size={18} aria-hidden />
            <span className="pointer-coarse:hidden">Escolher fotos</span>
            <span className="hidden pointer-coarse:inline">Galeria</span>
            <input type="file" accept="image/*" multiple hidden disabled={blocked} onChange={event => pick(event.currentTarget)} />
          </label>
          <span className="text-xs text-slate-500" aria-live="polite">
            {preparing ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-primary-ink">
                <LoaderCircle size={14} className="animate-spin" aria-hidden />
                {preparing.total > 1 ? `Preparando foto ${preparing.current} de ${preparing.total}…` : 'Preparando foto…'}
              </span>
            ) : room <= 0 ? (
              `O diário já tem ${DAILY_LIMITS.photos} fotos, que é o limite.`
            ) : null}
          </span>
        </div>
      )}
    </Section>
  );
}
