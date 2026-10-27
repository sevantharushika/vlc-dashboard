
import { useEffect, useState } from "react";
import mqtt from "mqtt";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Radio,
  Zap,
  Wifi,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./App.css";

type ValidationStatus = "VALID" | "INVALID" | "NOT PROVIDED";
type CrcStatus = "PASSED" | "ERROR" | "NOT PROVIDED";

interface Telemetry {
  deviceId: string;
  messageType: string;
  decodedMessage: string;
  packetCount: number | null;
  receivedAt: Date;
  receivedFrame: string | null;
  receivedCrc: string | null;
  calculatedCrc: string | null;
  frameValidation: ValidationStatus;
  crcStatus: CrcStatus;
  validationError: string | null;
}

interface ChartPoint {
  time: string;
  validFrames: number;
  invalidFrames: number;
}

type CommunicationStatus = "RECEIVED" | "PARSE ERROR";

interface CommunicationLog {
  id: string;
  time: string;
  device: string;
  event: string;
  status: CommunicationStatus;
}

const TELEMETRY_TOPIC = "factory/lighting/node01/telemetry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function payloadToText(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return new TextDecoder().decode(payload);
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  return null;
}

function parseTelemetry(value: unknown, receivedAt: Date): Telemetry {
  if (!isRecord(value)) throw new Error("MQTT payload must be a JSON object");

  const deviceId = nonEmptyString(value.device_id);
  const messageType = nonEmptyString(value.type) ?? "legacy_telemetry";
  const decodedMessage = nonEmptyString(value.message) ?? nonEmptyString(value.received_data);

  if (!deviceId || !decodedMessage) {
    throw new Error("MQTT payload is missing a device_id or decoded message");
  }
  if (messageType !== "vlc_message" && messageType !== "legacy_telemetry") {
    throw new Error(`Unsupported MQTT message type: ${messageType}`);
  }

  const receivedCrc = nonEmptyString(value.received_crc);
  const calculatedCrc = nonEmptyString(value.calculated_crc);
  const validationError = nonEmptyString(value.validation_error);
  const hasCrcPair = receivedCrc !== null && calculatedCrc !== null;
  const crcMatches = hasCrcPair && receivedCrc === calculatedCrc;

  let crcStatus: CrcStatus = "NOT PROVIDED";
  if (typeof value.crc_error === "boolean") {
    crcStatus = value.crc_error ? "ERROR" : "PASSED";
  } else if (hasCrcPair) {
    crcStatus = crcMatches ? "PASSED" : "ERROR";
  }

  let frameValidation: ValidationStatus = "NOT PROVIDED";
  if (typeof value.frame_valid === "boolean") {
    frameValidation = value.frame_valid ? "VALID" : "INVALID";
  } else if (validationError) {
    frameValidation = "INVALID";
  } else if (typeof value.crc_error === "boolean") {
    frameValidation = value.crc_error ? "INVALID" : "VALID";
  } else if (hasCrcPair) {
    frameValidation = crcMatches ? "VALID" : "INVALID";
  }

  return {
    deviceId,
    messageType,
    decodedMessage,
    packetCount: typeof value.packet_count === "number" && Number.isFinite(value.packet_count)
      ? value.packet_count
      : null,
    receivedAt,
    receivedFrame: nonEmptyString(value.received_frame),
    receivedCrc,
    calculatedCrc,
    frameValidation,
    crcStatus,
    validationError,
  };
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString();
}

function App() {
  const [activePage, setActivePage] = useState("Overview");
  const [mqttConnected, setMqttConnected] = useState(false);
  const [mqttError, setMqttError] = useState<string | null>(null);
  const [latestTelemetry, setLatestTelemetry] = useState<Telemetry | null>(null);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [telemetryHistory, setTelemetryHistory] = useState<ChartPoint[]>([]);
  const [communicationLogs, setCommunicationLogs] = useState<CommunicationLog[]>([]);

  useEffect(() => {
    const client = mqtt.connect("ws://127.0.0.1:9001", {
      reconnectPeriod: 2000,
      connectTimeout: 5000,
    });

    client.on("connect", () => {
      setMqttConnected(true);
      setMqttError(null);

      client.subscribe(TELEMETRY_TOPIC, (error) => {
        if (error) setMqttError(`Subscription failed: ${error.message}`);
      });
    });

    client.on("message", (_topic, payload) => {
      const receivedAt = new Date();
      const timeLabel = formatTime(receivedAt);
      const rawMessage = payloadToText(payload);

      try {
        if (rawMessage === null) throw new Error("Unsupported MQTT payload encoding");
        const telemetry = parseTelemetry(JSON.parse(rawMessage) as unknown, receivedAt);

        setMqttError(null);
        setLatestTelemetry(telemetry);
        setMessagesReceived((count) => count + 1);

        if (telemetry.frameValidation !== "NOT PROVIDED") {
          setTelemetryHistory((previous) => {
            const last = previous[previous.length - 1];
            const isValid = telemetry.frameValidation === "VALID";
            return [
              ...previous,
              {
                time: timeLabel,
                validFrames: (last?.validFrames ?? 0) + (isValid ? 1 : 0),
                invalidFrames: (last?.invalidFrames ?? 0) + (isValid ? 0 : 1),
              },
            ].slice(-20);
          });
        }

        setCommunicationLogs((previous) => [
          {
            id: `${receivedAt.getTime()}-${Math.random()}`,
            time: timeLabel,
            device: telemetry.deviceId,
            event: `${telemetry.decodedMessage} · Frame validation: ${telemetry.frameValidation} · CRC: ${telemetry.crcStatus}`,
            status: "RECEIVED" as const,
          },
          ...previous,
        ].slice(0, 10));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unable to parse MQTT payload";
        setMqttError(errorMessage);
        setCommunicationLogs((previous) => [
          {
            id: `${receivedAt.getTime()}-${Math.random()}`,
            time: timeLabel,
            device: "Unknown device",
            event: errorMessage,
            status: "PARSE ERROR" as const,
          },
          ...previous,
        ].slice(0, 10));
      }
    });

    client.on("error", (error) => {
      setMqttConnected(false);
      setMqttError(error.message);
    });

    client.on("close", () => setMqttConnected(false));
    client.on("reconnect", () => setMqttConnected(false));

    return () => {
      client.end(true);
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Lightbulb size={25} />
          </div>
          <div>
            <h2>VLC<span>Monitor</span></h2>
            <p>INDUSTRIAL NETWORK</p>
          </div>
        </div>

        <p className="nav-label">WORKSPACE</p>

        {["Overview", "Lighting Nodes", "Telemetry", "Communication Logs"].map(
          (page) => (
            <button
              key={page}
              className={`nav-item ${activePage === page ? "active" : ""}`}
              onClick={() => setActivePage(page)}
            >
              {page === "Overview" && <Activity size={18} />}
              {page === "Lighting Nodes" && <Lightbulb size={18} />}
              {page === "Telemetry" && <Zap size={18} />}
              {page === "Communication Logs" && <Radio size={18} />}
              {page}
            </button>
          )
        )}

        <div className="sidebar-bottom">
          <div className="connection-indicator">
            <span className={`status-dot ${mqttConnected ? "connected" : "disconnected"}`} />
            <div>
              <strong>Gateway service</strong>
                <p>{mqttConnected ? "Live MQTT connected" : "Waiting for MQTT"}</p>
            </div>
          </div>
          <p className="version">VLC Monitor · v0.1.0</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            <Lightbulb size={20} />
            <strong>VLC Monitor</strong>
          </div>
          <div className="breadcrumb">Workspace / {activePage}</div>
          <div className="topbar-right">
            <span className={`demo-badge ${mqttConnected ? "live" : "offline"}`}>
              {mqttConnected ? "LIVE MQTT" : "MQTT OFFLINE"}
            </span>
            <div className="avatar">VN</div>
          </div>
        </header>

        <section className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">INDUSTRIAL LIGHTING NETWORK</p>
              <h1>{activePage}</h1>
              <p className="subtitle">
                Monitor visible-light communication and lighting telemetry.
              </p>
            </div>
            <div className="gateway-status">
            <span className={`status-dot ${mqttConnected ? "connected" : "disconnected"}`} />
              {mqttConnected ? "Gateway connected" : "Gateway not connected"}
            </div>

{mqttError && <p>{mqttError}</p>}
          </div>

          {activePage === "Overview" ? (
            <>
              <div className="stats-grid">
  <article className="stat-card">
    <div className="stat-top">
      <span>Messages received</span>
      <Activity size={19} />
    </div>
    <div className="stat-value">{messagesReceived}</div>
    <p className="stat-note">Messages received during this session</p>
  </article>

  <article className="stat-card">
    <div className="stat-top">
      <span>Latest decoded message</span>
      <Zap size={19} />
    </div>
    <div className="stat-value stat-message">
      {latestTelemetry?.decodedMessage ?? "Waiting for data"}
    </div>
    <p className="stat-note">
      Packet counter: {latestTelemetry?.packetCount ?? "Not provided"}
    </p>
  </article>

  <article className="stat-card">
    <div className="stat-top">
      <span>Frame validation</span>
      <CheckCircle2 size={19} />
    </div>
    <div className="stat-value">
      {latestTelemetry?.frameValidation ?? "—"}
    </div>
    <p className="stat-note">
      {latestTelemetry
        ? `CRC status: ${latestTelemetry.crcStatus}`
        : "Waiting for telemetry"}
    </p>
  </article>

  <article className="stat-card">
    <div className="stat-top">
      <span>MQTT gateway</span>
      <Wifi size={19} />
    </div>
    <div className="stat-value">
      {mqttConnected ? "Connected" : "Offline"}
    </div>
    <p className="stat-note">
      {latestTelemetry ? `Last message from ${latestTelemetry.deviceId}` : "Connection status"}
    </p>
  </article>
</div>

              <div className="content-grid">
                <section className="panel chart-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Frame validation history</h2>
                      <p>Only frame results explicitly established by the payload</p>
                    </div>
                    {telemetryHistory.length > 0 && (
                      <span className="chart-legend">
                        <span className="legend-dot" /> Valid frames
                      </span>
                    )}
                  </div>

                  {telemetryHistory.length > 0 ? <div className="chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={telemetryHistory}>
                        <defs>
                          <linearGradient
                            id="powerGradient"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0%"
                              stopColor="#38bdf8"
                              stopOpacity={0.3}
                            />
                            <stop
                              offset="100%"
                              stopColor="#38bdf8"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          stroke="#dbe4de"
                          strokeDasharray="4 4"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="time"
                          stroke="#78877f"
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          stroke="#78877f"
                          tickLine={false}
                          axisLine={false}
                          width={35}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#ffffff",
                            border: "1px solid #d5dfd9",
                            borderRadius: 8,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="validFrames"
                          name="Valid frames"
                          stroke="#248b7b"
                          fill="url(#powerGradient)"
                          strokeWidth={2}
                        />
                        <Area
                          type="monotone"
                          dataKey="invalidFrames"
                          name="Invalid frames"
                          stroke="#c9645a"
                          fill="none"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div> : (
                    <div className="chart-empty">
                      Frame validation is not provided by the current ESP32 payload format.
                    </div>
                  )}
                  <p className="chart-footnote">
                    {telemetryHistory.length > 0
                      ? `Showing ${telemetryHistory.length} received frame-validation results.`
                      : "MQTT message reception is tracked separately from frame validation."}
                  </p>
                </section>

                <section className="panel node-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Lighting nodes</h2>
                      <p>Registered devices</p>
                    </div>
                    <Lightbulb size={20} />
                  </div>

                  <div className="node-item">
                    <div className="node-icon"><Lightbulb size={22} /></div>
                    <div className="node-info">
                      <strong>VLC Node 01</strong>
                      <p>factory/lighting/node01/telemetry</p>
                      <span className={`node-tag ${latestTelemetry ? "live" : "offline"}`}>
                        {latestTelemetry ? "LIVE MQTT" : "AWAITING MQTT"}
                      </span>
                    </div>
                  </div>

                  <div className="node-metrics">
  <div>
    <span>Received data</span>
    <strong>{latestTelemetry?.decodedMessage ?? "—"}</strong>
  </div>
  <div>
    <span>Device ID</span>
    <strong>{latestTelemetry?.deviceId ?? "—"}</strong>
  </div>
</div>

<div className="node-metrics">
  <div>
    <span>Packet counter</span>
    <strong>{latestTelemetry?.packetCount ?? "—"}</strong>
  </div>
  <div>
    <span>Frame validation / CRC</span>
    <strong>{latestTelemetry ? `${latestTelemetry.frameValidation} / ${latestTelemetry.crcStatus}` : "—"}</strong>
  </div>
</div>

<div className="node-metrics">
  <div>
    <span>Last message received</span>
    <strong>{latestTelemetry ? formatTime(latestTelemetry.receivedAt) : "—"}</strong>
  </div>
  <div>
    <span>MQTT connection</span>
    <strong>{mqttConnected ? "Connected" : "Disconnected"}</strong>
  </div>
</div>

                  <div className="node-footer">
                    <Wifi size={16} />
                    {mqttConnected ? "MQTT gateway connected" : "MQTT gateway disconnected"}
                  </div>
                </section>
              </div>

              <section className="panel log-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent communication events</h2>
                    <p>Latest successfully parsed MQTT messages and parsing errors</p>
                  </div>
                  <AlertTriangle size={20} />
                </div>

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>TIME</th>
                        <th>DEVICE</th>
                        <th>EVENT</th>
                        <th>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {communicationLogs.length === 0 ? (
                        <tr>
                          <td colSpan={4}>Waiting for MQTT messages...</td>
                        </tr>
                      ) : (
                        communicationLogs.map((log) => (
                          <tr key={log.id}>
                            <td>{log.time}</td>
                            <td>{log.device}</td>
                            <td>{log.event}</td>
                            <td>
                              <span
                                className={`table-status ${
                                  log.status === "RECEIVED" ? "success" : "warning"
                                }`}
                              >
                                {log.status}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : activePage === "Lighting Nodes" ? (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Registered lighting nodes</h2>
                  <p>Live node information from MQTT telemetry</p>
                </div>
                <Lightbulb size={20} />
              </div>

              <div className="node-item">
                <div className="node-icon">
                  <Lightbulb size={22} />
                </div>
                <div className="node-info">
                  <strong>{latestTelemetry?.deviceId ?? "VLC Node 01"}</strong>
                  <p>{TELEMETRY_TOPIC}</p>
                  <span className={`node-tag ${latestTelemetry ? "live" : "offline"}`}>
                    {latestTelemetry ? "LIVE MQTT" : "AWAITING MQTT"}
                  </span>
                </div>
              </div>

              <div className="node-metrics">
                <div>
                  <span>MQTT connection</span>
                  <strong>{mqttConnected ? "Connected" : "Disconnected"}</strong>
                </div>
                <div>
                  <span>Latest decoded message</span>
                  <strong>{latestTelemetry?.decodedMessage ?? "Awaiting data"}</strong>
                </div>
              </div>

              <div className="node-metrics">
                <div>
                  <span>Messages received</span>
                  <strong>{messagesReceived}</strong>
                </div>
                <div>
                  <span>CRC status</span>
                  <strong>{latestTelemetry?.crcStatus ?? "—"}</strong>
                </div>
              </div>
              <div className="node-metrics">
                <div>
                  <span>Device ID</span>
                  <strong>{latestTelemetry?.deviceId ?? "vlc_node_01"}</strong>
                </div>
                <div>
                  <span>Packet counter</span>
                  <strong>{latestTelemetry?.packetCount ?? "—"}</strong>
                </div>
              </div>
              <div className="node-metrics">
                <div>
                  <span>Last message received</span>
                  <strong>{latestTelemetry ? formatTime(latestTelemetry.receivedAt) : "—"}</strong>
                </div>
                <div>
                  <span>Frame validation</span>
                  <strong>{latestTelemetry?.frameValidation ?? "—"}</strong>
                </div>
              </div>
            </section>
          ) : activePage === "Telemetry" ? (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Latest telemetry</h2>
                  <p>Decoded data received from the VLC gateway</p>
                </div>
                <Activity size={20} />
              </div>

              {latestTelemetry ? (
                <div className="table-wrapper">
                  <table>
                    <tbody>
                      <tr>
                        <th>Device ID</th>
                        <td>{latestTelemetry.deviceId}</td>
                      </tr>
                      <tr>
                        <th>Dashboard reception time</th>
                        <td>{formatTime(latestTelemetry.receivedAt)}</td>
                      </tr>
                      <tr>
                        <th>MQTT topic</th>
                        <td>{TELEMETRY_TOPIC}</td>
                      </tr>
                      <tr>
                        <th>Message type</th>
                        <td>{latestTelemetry.messageType}</td>
                      </tr>
                      <tr>
                        <th>Decoded VLC message</th>
                        <td>{latestTelemetry.decodedMessage}</td>
                      </tr>
                      <tr>
                        <th>Packet counter</th>
                        <td>{latestTelemetry.packetCount ?? "Not provided"}</td>
                      </tr>
                      <tr>
                        <th>Received frame</th>
                        <td>{latestTelemetry.receivedFrame ?? "Not provided"}</td>
                      </tr>
                      <tr>
                        <th>Received CRC</th>
                        <td>{latestTelemetry.receivedCrc ?? "Not provided"}</td>
                      </tr>
                      <tr>
                        <th>Calculated CRC</th>
                        <td>{latestTelemetry.calculatedCrc ?? "Not provided"}</td>
                      </tr>
                      <tr>
                        <th>Frame validation / CRC</th>
                        <td>{latestTelemetry.frameValidation} / {latestTelemetry.crcStatus}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>Waiting for MQTT telemetry. Check that the publisher is running.</p>
              )}
            </section>
          ) : (
            <section className="panel log-panel">
              <div className="panel-heading">
                <div>
                  <h2>Communication logs</h2>
                  <p>Most recent parsed MQTT messages and parsing errors</p>
                </div>
                <Radio size={20} />
              </div>

              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>TIME</th>
                      <th>DEVICE</th>
                      <th>EVENT</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {communicationLogs.length === 0 ? (
                      <tr>
                        <td colSpan={4}>Waiting for MQTT messages...</td>
                      </tr>
                    ) : (
                      communicationLogs.map((log) => (
                        <tr key={log.id}>
                          <td>{log.time}</td>
                          <td>{log.device}</td>
                          <td>{log.event}</td>
                          <td>
                            <span
                              className={`table-status ${
                                log.status === "RECEIVED" ? "success" : "warning"
                              }`}
                            >
                              {log.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <footer className="page-footer">
            VLC Industrial Monitoring · Development Preview
          </footer>
        </section>
      </main>
    </div>
  );
}

export default App;
