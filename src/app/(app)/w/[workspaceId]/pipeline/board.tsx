"use client";

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import Link from "next/link";
import { useState, useTransition } from "react";
import { deleteDealAction, moveDealAction, setDealStatusAction } from "@/actions/pipelines";
import { contactName, formatMoney } from "@/lib/format";
import type { BoardCard } from "@/server/pipelines";

type Columns = Record<string, BoardCard[]>;

function group(stages: { id: string }[], cards: BoardCard[]): Columns {
  const cols: Columns = Object.fromEntries(stages.map((s) => [s.id, []]));
  for (const card of cards) cols[card.stageId]?.push(card);
  return cols;
}

export function Board({
  workspaceId,
  stages,
  cards,
}: {
  workspaceId: string;
  stages: { id: string; name: string }[];
  cards: BoardCard[];
}) {
  const [columns, setColumns] = useState(() => group(stages, cards));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Take fresh server data whenever it changes (after an action refreshes the page).
  const [source, setSource] = useState({ stages, cards });
  if (source.stages !== stages || source.cards !== cards) {
    setSource({ stages, cards });
    setColumns(group(stages, cards));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findColumn = (id: string) =>
    id in columns ? id : Object.keys(columns).find((col) => columns[col].some((c) => c.id === id));

  const activeCard = activeId ? Object.values(columns).flat().find((c) => c.id === activeId) : null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  // Move the card into another column while hovering, so the drop spot is visible.
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const from = findColumn(String(active.id));
    const to = findColumn(String(over.id));
    if (!from || !to || from === to) return;
    setColumns((cols) => {
      const card = cols[from].find((c) => c.id === active.id)!;
      const overIndex = cols[to].findIndex((c) => c.id === over.id);
      const index = overIndex >= 0 ? overIndex : cols[to].length;
      const target = [...cols[to]];
      target.splice(index, 0, { ...card, stageId: to });
      return { ...cols, [from]: cols[from].filter((c) => c.id !== active.id), [to]: target };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over) return;
    const col = findColumn(String(active.id));
    const overCol = findColumn(String(over.id));
    if (!col || col !== overCol) return;
    const oldIndex = columns[col].findIndex((c) => c.id === active.id);
    const overIndex = columns[col].findIndex((c) => c.id === over.id);
    const newIndex = overIndex >= 0 ? overIndex : columns[col].length - 1;
    const next = oldIndex !== newIndex ? arrayMove(columns[col], oldIndex, newIndex) : columns[col];
    setColumns((cols) => ({ ...cols, [col]: next }));
    const finalIndex = next.findIndex((c) => c.id === active.id);
    startTransition(() => moveDealAction(workspaceId, String(active.id), col, finalIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setColumns(group(stages, cards));
      }}
    >
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
        {stages.map((stage) => (
          <Column key={stage.id} id={stage.id} name={stage.name} cards={columns[stage.id] ?? []} workspaceId={workspaceId} />
        ))}
      </div>
      <DragOverlay>{activeCard ? <CardBody card={activeCard} workspaceId={workspaceId} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ id, name, cards, workspaceId }: { id: string; name: string; cards: BoardCard[]; workspaceId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const total = cards.reduce((sum, c) => sum + c.valueCents, 0);
  return (
    <section className="flex w-72 shrink-0 flex-col" aria-label={name}>
      <header className="mb-2 flex items-baseline justify-between px-1">
        <h3 className="text-sm font-semibold">
          {name} <span className="font-normal text-slate-400">{cards.length}</span>
        </h3>
        <span className="text-xs tabular-nums text-slate-500">{formatMoney(total)}</span>
      </header>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={clsx("min-h-40 flex-1 space-y-2 rounded-xl p-2 transition-colors", isOver ? "bg-brand-50" : "bg-slate-100")}
        >
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} workspaceId={workspaceId} />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableCard({ card, workspaceId }: { card: BoardCard; workspaceId: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <CardBody card={card} workspaceId={workspaceId} />
    </div>
  );
}

function CardBody({ card, workspaceId, dragging }: { card: BoardCard; workspaceId: string; dragging?: boolean }) {
  const [pending, startTransition] = useTransition();
  const name = card.contactId
    ? contactName({ firstName: card.contactFirstName ?? "", lastName: card.contactLastName ?? "", email: card.contactEmail, phone: card.contactPhone })
    : null;
  return (
    <article
      className={clsx(
        "group cursor-grab rounded-lg border border-slate-200 bg-white p-3 shadow-sm active:cursor-grabbing",
        dragging && "rotate-1 shadow-lg",
        pending && "opacity-50",
      )}
    >
      <div className="text-sm font-medium">{card.title}</div>
      {name && (
        <Link
          href={`/w/${workspaceId}/contacts/${card.contactId}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="text-xs text-slate-500 hover:text-brand-600"
        >
          {name}
        </Link>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm tabular-nums text-slate-700">{formatMoney(card.valueCents)}</span>
        <span className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
            onClick={() => startTransition(() => setDealStatusAction(workspaceId, card.id, "won"))}
          >
            Won
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
            onClick={() => startTransition(() => setDealStatusAction(workspaceId, card.id, "lost"))}
          >
            Lost
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
            onClick={() => confirm(`Delete "${card.title}"?`) && startTransition(() => deleteDealAction(workspaceId, card.id))}
          >
            Delete
          </button>
        </span>
      </div>
    </article>
  );
}
