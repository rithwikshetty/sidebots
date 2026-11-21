import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { AgentWithLatest, Found } from "@server/contract.ts";
import { cn } from "../lib/cn.ts";
import { findMessages, useAgents, useOnline } from "../lib/store.ts";
import { closeSearch, openChat } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { Input } from "../ui/Input.tsx";
import { ROW, RowBody } from "./SidebarRow.tsx";

// How long the person rests from typing before the server is asked.
const SEARCH_DELAY_MS = 200;

/** A result of a search: an agent whose name matched, or a message a search found in that agent's chat. */
type Result = { agent: AgentWithLatest; found?: Found };

/**
 * Search, at the top of the sidebar in the agents' place: a field, and while
 * it holds text, the agents whose name matches and then the messages that
 * contain it, from every chat. The arrow keys move through the results, Enter
 * or a click opens the chat at the result, and Esc closes search.
 */
export function SidebarSearch() {
  const agents = useAgents();
  const online = useOnline();
  const [typed, setTyped] = useState("");
  const search = typed.trim();
  const found = useFound(search);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const results: Result[] = search
    ? [
        ...agents.filter((agent) => agent.name.toLowerCase().includes(search.toLowerCase())).map((agent) => ({ agent })),
        ...(found ?? []).flatMap((message) => {
          const agent = agents.find((item) => item.id === message.agent_id);
          return agent ? [{ agent, found: message }] : [];
        }),
      ]
    : [];
  const shown = Math.min(active, results.length - 1);

  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${shown}"]`)?.scrollIntoView({ block: "nearest" });
  }, [shown]);

  const open = (result: Result) => openChat(result.agent.id, result.found?.id);

  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) setActive((shown + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter" && results[shown]) {
      event.preventDefault();
      open(results[shown]);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-13">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <Input
          autoFocus
          icon={Search}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={key}
          placeholder="Search"
          aria-label="Search"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="search-results"
          aria-activedescendant={results.length ? `search-result-${shown}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          data-testid="search"
          className="flex-1"
        />
        <IconButton icon={X} label="Close search" onClick={closeSearch} />
      </div>
      <div ref={list} id="search-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {results.map((result, index) => (
          <div
            key={result.found ? `found-${result.found.id}` : `agent-${result.agent.id}`}
            id={`search-result-${index}`}
            role="option"
            aria-selected={index === shown}
            data-index={index}
            data-testid={result.found ? `found-${result.found.id}` : `result-${result.agent.id}`}
            onPointerMove={() => setActive(index)}
            onClick={() => open(result)}
            className={cn(ROW, index === shown && "bg-hover")}
          >
            <RowBody agent={result.agent} online={online} found={result.found} search={search} />
          </div>
        ))}
        {search && found && results.length === 0 ? <p className="animate-fade-in pt-6 text-center text-sm text-ink2">No results</p> : null}
      </div>
    </div>
  );
}

/** The messages that contain `text`, from every chat of the person's. Null until the server has answered. */
function useFound(text: string): Found[] | null {
  const [found, setFound] = useState<Found[] | null>(null);
  useEffect(() => {
    if (!text) return setFound(null);
    let current = true;
    const keep = (messages: Found[]) => current && setFound(messages);
    const timer = setTimeout(() => findMessages(text).then(keep, () => keep([])), SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text]);
  return found;
}
