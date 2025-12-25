import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ScrollArea } from "./ui/scroll-area";
import { toast } from "sonner";
import { useSocket } from "./SocketProvider";
import { useTheme } from "./ThemeProvider";
type MonacoEditorProps = {
  height: string;
  defaultLanguage: string;
  theme: string;
  value: string;
  onChange: (v?: string) => void;
  options?: Record<string, any>;
};
function MonacoEditor({ height, defaultLanguage, theme, value, onChange, options }: MonacoEditorProps) {
  const [Editor, setEditor] = useState<any>(null);
  useEffect(() => {
    let mounted = true;
    const MOD: any = "@monaco-editor/react";
    import(MOD).then((mod) => {
      if (mounted) setEditor(mod.default);
    }).catch(() => {
      setEditor(null);
    });
    return () => { mounted = false; };
  }, []);
  if (Editor) {
    return (
      <Editor
        height={height}
        defaultLanguage={defaultLanguage}
        theme={theme}
        value={value}
        onChange={(v?: string) => onChange(v)}
        options={options}
      />
    );
  }
  return (
    <textarea
      style={{ height, width: "100%" }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

type AgentCodeEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultAgentId?: string | null;
};

export function AgentCodeEditor({ open, onOpenChange, defaultAgentId = null }: AgentCodeEditorProps) {
  const { agents, selectedAgent, setSelectedAgent, previewFile, uploadFile, socket, sendCommand, connected } = useSocket();
  const { theme } = useTheme();
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId || selectedAgent);
  const [filePath, setFilePath] = useState<string>("/client.py");
  const [code, setCode] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [tab, setTab] = useState<string>("editor");
  const [debugRunning, setDebugRunning] = useState<boolean>(false);
  const [debugOutput, setDebugOutput] = useState<string[]>([]);
  const [bulkUpdating, setBulkUpdating] = useState<boolean>(false);
  const previewRequestRef = useRef<{ agentId: string; filePath: string } | null>(null);

  const monacoTheme = useMemo(() => {
    if (theme === "dark") return "vs-dark";
    if (theme === "light") return "vs-light";
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "vs-dark" : "vs-light";
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    setAgentId(defaultAgentId || selectedAgent || agents.find(a => a.status === "online")?.id || null);
  }, [open, defaultAgentId, selectedAgent, agents]);

  useEffect(() => {
    const handlePreviewReady = async (event: any) => {
      const data = event?.detail;
      if (!data || !data.url) return;
      const req = previewRequestRef.current;
      if (!req) return;
      try {
        const res = await fetch(data.url);
        const text = await res.text();
        setCode(text);
        toast.success(`Loaded ${data.filename || req.filePath}`);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load file content");
      }
    };
    window.addEventListener("file_preview_ready", handlePreviewReady);
    return () => {
      window.removeEventListener("file_preview_ready", handlePreviewReady);
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (data: any) => {
      if (!data || typeof data !== "object") return;
      const aid = String(data.agent_id || "");
      if (agentId && aid === agentId) {
        const text = typeof data.formatted_text === "string" ? data.formatted_text : (typeof data.output === "string" ? data.output : "");
        if (text) {
          setDebugOutput(prev => [...prev.slice(-199), text]);
        }
      }
    };
    socket.on("command_result", handler);
    return () => {
      try { socket.off("command_result", handler); } catch {}
    };
  }, [socket, agentId]);

  const normalizeDestinationDir = (destinationPath: string, filename: string): string => {
    const raw = (destinationPath || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    const filenameLower = filename.toLowerCase();
    if (lower.endsWith(`/${filenameLower}`) || lower.endsWith(`\\${filenameLower}`)) {
      return raw.slice(0, raw.length - filename.length - 1);
    }
    return raw;
  };

  const handleLoadCode = () => {
    if (!agentId || !connected) {
      toast.error("No agent connected");
      return;
    }
    setLoading(true);
    previewRequestRef.current = { agentId, filePath };
    previewFile?.(agentId, filePath);
    setTimeout(() => setLoading(false), 800);
  };

  const handleDebug = async () => {
    if (!agentId || !connected) {
      toast.error("No agent connected");
      return;
    }
    const dir = normalizeDestinationDir(filePath, "client_debug.py");
    const file = new File([code], "client_debug.py", { type: "text/x-python" });
    setDebugRunning(true);
    setDebugOutput([]);
    uploadFile(agentId, file, dir);
    const target = dir ? `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}client_debug.py` : "client_debug.py";
    setTimeout(() => {
      sendCommand(agentId, `python -m py_compile "${target}"`);
    }, 500);
    setTimeout(() => setDebugRunning(false), 2000);
    setTab("debugger");
  };

  const handleUpdateAll = async () => {
    if (!connected) {
      toast.error("Not connected");
      return;
    }
    const onlineAgents = agents.filter(a => a.status === "online");
    if (onlineAgents.length === 0) {
      toast.error("No online agents");
      return;
    }
    setBulkUpdating(true);
    const dir = normalizeDestinationDir(filePath, "client.py");
    const file = new File([code], "client.py", { type: "text/x-python" });
    for (const a of onlineAgents) {
      uploadFile(a.id, file, dir);
      await new Promise(r => setTimeout(r, 200));
    }
    setBulkUpdating(false);
    toast.success(`Pushed updates to ${onlineAgents.length} agent(s)`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] lg:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>Agent Code Update</DialogTitle>
          <DialogDescription>Edit and validate client.py before pushing to agents</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Agent</span>
              <select
                className="border rounded h-8 px-2 text-sm bg-background"
                value={agentId || ""}
                onChange={(e) => {
                  const v = e.target.value || "";
                  setAgentId(v || null);
                  setSelectedAgent(v || null);
                }}
              >
                <option value="">Select</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.status})</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Path</span>
              <Input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/client.py" />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleLoadCode} disabled={!agentId || loading}>
                Load Code
              </Button>
              <Badge variant="outline">{connected ? "Connected" : "Disconnected"}</Badge>
            </div>
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="editor">Editor</TabsTrigger>
              <TabsTrigger value="debugger">Debugger</TabsTrigger>
            </TabsList>
            <TabsContent value="editor" className="space-y-2">
              <div className="border rounded">
                <MonacoEditor
                  height="520px"
                  defaultLanguage="python"
                  theme={monacoTheme}
                  value={code}
                  onChange={(v?: string) => setCode(v || "")}
                  options={{
                    fontSize: 13,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: "on",
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={handleDebug} disabled={!agentId || debugRunning}>
                  Run Debugger
                </Button>
                <Button size="sm" onClick={handleUpdateAll} disabled={bulkUpdating || !code.trim()}>
                  Push to All Agents
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="debugger">
              <CardLike title="Pre-Update Debugger">
                <ScrollArea className="h-[420px]">
                  <pre className="text-xs p-3">{debugOutput.join("\n") || "No output yet"}</pre>
                </ScrollArea>
              </CardLike>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CardLike({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded">
      <div className="px-3 py-2 border-b text-sm font-medium">{title}</div>
      <div className="p-2">{children}</div>
    </div>
  );
}
