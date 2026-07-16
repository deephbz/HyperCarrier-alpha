import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Lane, Snapshot } from "./types";

export function trafficDeepLink(
  baseUrl: string,
  selection: { teamName?: string; sessionIds?: string[] },
) {
  const url = new URL("/traffic", baseUrl);
  if (selection.teamName) url.searchParams.set("team", `piteams:${selection.teamName}`);
  else
    for (const sessionId of selection.sessionIds ?? [])
      url.searchParams.append("agent", `pi-session:${sessionId}`);
  return url.toString();
}

type TrafficContextValue = {
  baseUrl: string | null;
  selectedSessionIds: Set<string>;
  toggleSession: (sessionId: string) => void;
  openAgents: () => void;
  openTeam: (teamName: string) => void;
};

const TrafficContext = createContext<TrafficContextValue | null>(null);

function useTraffic() {
  const value = useContext(TrafficContext);
  if (!value) throw new Error("Traffic controls require TrafficProvider");
  return value;
}

export function TrafficProvider({
  enabled = true,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch("/api/traffic/config", { signal: controller.signal })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("traffic config")),
      )
      .then((config: { baseUrl?: unknown }) => {
        if (!controller.signal.aborted && typeof config.baseUrl === "string")
          setBaseUrl(config.baseUrl);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  const value = useMemo<TrafficContextValue>(
    () => ({
      baseUrl,
      selectedSessionIds,
      toggleSession: (sessionId) =>
        setSelectedSessionIds((previous) => {
          const next = new Set(previous);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        }),
      openAgents: () => {
        if (!baseUrl || selectedSessionIds.size === 0) return;
        window.open(
          trafficDeepLink(baseUrl, { sessionIds: [...selectedSessionIds] }),
          "_blank",
          "noopener,noreferrer",
        );
      },
      openTeam: (teamName) => {
        if (!baseUrl || !teamName) return;
        window.open(trafficDeepLink(baseUrl, { teamName }), "_blank", "noopener,noreferrer");
      },
    }),
    [baseUrl, selectedSessionIds],
  );
  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>;
}

function isSessionUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function TrafficAgentToggle({ sessionId, label }: { sessionId: string; label: string }) {
  const { selectedSessionIds, toggleSession } = useTraffic();
  return (
    <div className="traffic-agent-select">
      <input
        id={`traffic-agent-${sessionId}`}
        type="checkbox"
        checked={selectedSessionIds.has(sessionId)}
        disabled={!isSessionUuid(sessionId)}
        onChange={() => toggleSession(sessionId)}
        aria-label={`Include ${label} in traffic analysis`}
      />
    </div>
  );
}

export function InspectorTrafficAction({ teamName }: { teamName: string }) {
  const { baseUrl, openTeam } = useTraffic();
  return (
    <button className="traffic-action" disabled={!baseUrl} onClick={() => openTeam(teamName)}>
      Open traffic analysis
    </button>
  );
}

export function TrafficLaunch({
  snapshot,
  filtered,
  onShowAll,
}: {
  snapshot: Snapshot | null;
  filtered: Lane[];
  onShowAll: () => void;
}) {
  const { baseUrl, selectedSessionIds, openAgents, openTeam } = useTraffic();
  const [teamName, setTeamName] = useState("");
  const teams = snapshot?.teams ?? [];
  const visibleSessionIds = new Set(filtered.map((lane) => lane.session.id));
  const hiddenRecordedCount = (snapshot?.sessions ?? []).filter(
    (session) => !visibleSessionIds.has(session.id),
  ).length;
  return (
    <div className="traffic-launch" aria-label="Traffic analysis">
      {teams.length > 0 && (
        <>
          <label>
            Team trace
            <select
              aria-label="Team traffic scope"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
            >
              <option value="">Choose an attributable Pi Team</option>
              {teams.map((team) => (
                <option key={team.name} value={team.name}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!baseUrl || !teamName} onClick={() => openTeam(teamName)}>
            Open Team traffic analysis
          </button>
        </>
      )}
      {hiddenRecordedCount > 0 && (
        <button className="traffic-recovery" onClick={onShowAll}>
          Show all {hiddenRecordedCount} recorded Session{hiddenRecordedCount === 1 ? "" : "s"}
        </button>
      )}
      <span>
        {selectedSessionIds.size} explicit Agent{selectedSessionIds.size === 1 ? "" : "s"} selected
      </span>
      <button disabled={!baseUrl || selectedSessionIds.size === 0} onClick={openAgents}>
        Open traffic analysis for {selectedSessionIds.size || "selected"} Agent
        {selectedSessionIds.size === 1 ? "" : "s"}
      </button>
    </div>
  );
}
