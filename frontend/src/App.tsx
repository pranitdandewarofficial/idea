import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Building2, Loader2 } from "lucide-react";
import { api, bootstrap, setToken } from "./api/client";
import { live } from "./live/stream";
import { useApp } from "./store/app";
import { Shell } from "./components/Shell";
import { CityArea } from "./areas/CityArea";
import { CommandCenter } from "./areas/CommandCenter";
import { AgentDirectory } from "./areas/AgentDirectory";
import { AgentWorkspace } from "./areas/AgentWorkspace";
import { TaskManager } from "./areas/TaskManager";
import { ProjectsArea } from "./areas/ProjectsArea";
import { ProjectDetail } from "./areas/ProjectDetail";
import { ProvidersArea } from "./areas/ProvidersArea";
import { KnowledgeArea } from "./areas/KnowledgeArea";
import { ActivityCenter } from "./areas/ActivityCenter";
import { SettingsArea } from "./areas/SettingsArea";
import { Button } from "./components/ui";

export default function App() {
  const { ready, bootError, boot, refreshHealth } = useApp();

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!ready) return;
    live.start();
    const health = window.setInterval(() => void refreshHealth(), 15_000);
    const onVisible = () => {
      if (!document.hidden) void refreshHealth();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(health);
      document.removeEventListener("visibilitychange", onVisible);
      live.stop();
    };
  }, [ready, refreshHealth]);

  if (bootError) return <BootError message={bootError} />;
  if (!ready) return <Booting />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<CityArea />} />
        <Route path="/command" element={<CommandCenter />} />
        <Route path="/agents" element={<AgentDirectory />} />
        <Route path="/agents/:agentId" element={<AgentDirectory />} />
        <Route path="/workspace" element={<AgentWorkspace />} />
        <Route path="/workspace/:agentId" element={<AgentWorkspace />} />
        <Route path="/tasks" element={<TaskManager />} />
        <Route path="/projects" element={<ProjectsArea />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/providers" element={<ProvidersArea />} />
        <Route path="/knowledge" element={<KnowledgeArea />} />
        <Route path="/activity" element={<ActivityCenter />} />
        <Route path="/settings" element={<SettingsArea />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Booting() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-faint">
      <Building2 size={22} className="text-accent" />
      <p className="flex items-center gap-2 text-[13px]">
        <Loader2 size={13} className="animate-spin" />
        Connecting to the local backend…
      </p>
      <p className="max-w-md text-center text-xs">
        Reading <code className="numeric">/api/setup/status</code> for the local access token, then
        <code className="numeric"> /api/health</code>.
      </p>
    </div>
  );
}

function BootError({ message }: { message: string }) {
  const retry = async () => {
    useApp.setState({ bootError: null });
    try {
      await bootstrap();
      await api.get("/api/health");
      useApp.setState({ ready: true, booting: false });
    } catch (error) {
      useApp.setState({ bootError: String(error instanceof Error ? error.message : error) });
    }
  };

  const manualToken = () => {
    const value = window.prompt(
      "Paste the API token printed by the backend (or stored in backend/.data/api_token):",
    );
    if (!value) return;
    setToken(value);
    void retry();
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="panel w-full max-w-lg p-5">
        <h1 className="text-[16px] font-semibold">The frontend cannot reach the backend</h1>
        <p className="mt-1 text-[13px] text-ink-soft">{message}</p>
        <div className="code mt-3">{`cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`}</div>
        <p className="mt-3 text-xs text-ink-faint">
          The Vite dev server proxies <code className="numeric">/api</code> and <code className="numeric">/ws</code> to
          <code className="numeric"> http://127.0.0.1:8000</code>. Nothing else needs to be reachable.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="accent" onClick={() => void retry()}>Retry</Button>
          <Button onClick={manualToken}>Enter token manually</Button>
        </div>
      </div>
    </div>
  );
}
