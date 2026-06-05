/**
 * Hand-written type boundary over `@grpc/proto-loader`'s `any` values.
 *
 * The loader is configured with `keepCase: true`, so every field arrives in
 * **snake_case** exactly as declared in the .proto files. These interfaces mirror
 * that — a camelCase typo would silently read `undefined` at runtime, so all
 * higher-level code goes through these types instead of touching raw `any`.
 *
 * Only the messages used by Phase 1 are modelled. Extend as later phases wrap
 * more RPCs. Source: proto/cc/arduino/cli/commands/v1/*.proto.
 */

/** common.proto — Instance { int32 id } */
export interface Instance {
  id: number;
}

/** common.proto — TaskProgress { name, message, completed, percent } */
export interface TaskProgress {
  name: string;
  message: string;
  completed: boolean;
  /** 0–100 per arduino-cli; verify at runtime. */
  percent: number;
}

/** common.proto — DownloadProgress (oneof start | update | end) */
export interface DownloadProgress {
  start?: { url: string; label: string };
  update?: { downloaded: number; total_size: number };
  end?: { success: boolean; message: string };
}

/** port.proto — Port */
export interface Port {
  address: string;
  label: string;
  protocol: string;
  protocol_label: string;
  properties: Record<string, string>;
  hardware_id: string;
}

/** board.proto — BoardListItem */
export interface BoardListItem {
  name: string;
  fqbn: string;
  is_hidden: boolean;
}

/** board.proto — DetectedPort */
export interface DetectedPort {
  matching_boards: BoardListItem[];
  port: Port;
}

/** board.proto — BoardListResponse */
export interface BoardListResponse {
  ports: DetectedPort[];
  warnings: string[];
}

/** board.proto — BoardListAllResponse */
export interface BoardListAllResponse {
  boards: BoardListItem[];
}

/**
 * board.proto — BoardListWatchResponse.
 * `event_type` is `"add"` | `"remove"` (as emitted by the discovery tool).
 */
export interface BoardListWatchResponse {
  event_type: string;
  port?: DetectedPort;
  error: string;
}

/** common.proto — Sketch (subset used by Phase 1) */
export interface Sketch {
  main_file: string;
  location_path: string;
  other_sketch_files: string[];
  default_fqbn: string;
  default_port: string;
  default_protocol: string;
}

/** commands.proto — LoadSketchResponse */
export interface LoadSketchResponse {
  sketch: Sketch;
}

/** commands.proto — SetSketchDefaultsRequest (writes sketch.yaml) */
export interface SetSketchDefaultsRequest {
  sketch_path: string;
  default_fqbn?: string;
  default_port_address?: string;
  default_port_protocol?: string;
  default_programmer?: string;
}

/** commands.proto — SetSketchDefaultsResponse (echoes what was written) */
export interface SetSketchDefaultsResponse {
  default_fqbn: string;
  default_port_address: string;
  default_port_protocol: string;
  default_programmer: string;
}

/** common.proto — PlatformMetadata (subset) */
export interface PlatformMetadata {
  id: string;
  maintainer: string;
  deprecated: boolean;
}

/** common.proto — PlatformRelease (subset) */
export interface PlatformRelease {
  name: string;
  version: string;
  installed: boolean;
  deprecated: boolean;
  compatible: boolean;
}

/** common.proto — PlatformSummary */
export interface PlatformSummary {
  metadata: PlatformMetadata;
  releases: Record<string, PlatformRelease>;
  /** Empty string when not installed. */
  installed_version: string;
  /** Empty string when nothing installable. */
  latest_version: string;
}

/** core.proto — PlatformSearchResponse */
export interface PlatformSearchResponse {
  search_output: PlatformSummary[];
}

/**
 * Shared streaming shape for PlatformInstall/Uninstall/Upgrade. Branch on
 * `message`: `progress` (download) and `task_progress` (stage) are status;
 * `result` is terminal. (Uninstall has no download progress.)
 */
export interface PlatformStreamResponse {
  message: "progress" | "task_progress" | "result";
  progress?: DownloadProgress;
  task_progress?: TaskProgress;
}

/** lib.proto — LibraryRelease (subset) */
export interface LibraryRelease {
  author: string;
  version: string;
  maintainer: string;
  sentence: string;
  paragraph: string;
  website: string;
  category: string;
  license: string;
}

/** lib.proto — SearchedLibrary */
export interface SearchedLibrary {
  name: string;
  releases: Record<string, LibraryRelease>;
  latest?: LibraryRelease;
  available_versions: string[];
}

/** lib.proto — LibrarySearchResponse */
export interface LibrarySearchResponse {
  libraries: SearchedLibrary[];
  status: string;
}

/** lib.proto — Library (subset) */
export interface Library {
  name: string;
  author: string;
  sentence: string;
  version: string;
  install_dir: string;
  types: string[];
  /** Enum string, e.g. LIBRARY_LOCATION_USER. */
  location: string;
}

/** lib.proto — InstalledLibrary */
export interface InstalledLibrary {
  library: Library;
  release?: LibraryRelease;
}

/** lib.proto — LibraryListResponse */
export interface LibraryListResponse {
  installed_libraries: InstalledLibrary[];
}

/** lib.proto — LibraryDependencyStatus */
export interface LibraryDependencyStatus {
  name: string;
  version_required: string;
  version_installed: string;
}

/** lib.proto — LibraryResolveDependenciesResponse */
export interface LibraryResolveDependenciesResponse {
  dependencies: LibraryDependencyStatus[];
}

/** compile.proto — CompileDiagnostic and friends */
export interface CompileDiagnosticRef {
  message: string;
  file: string;
  line: number;
  column: number;
}

export interface CompileDiagnostic {
  /** "ERROR" | "WARNING" | ... */
  severity: string;
  message: string;
  file: string;
  /** 1-based; 0 when unavailable. */
  line: number;
  /** 1-based; 0 when unavailable. */
  column: number;
  context: CompileDiagnosticRef[];
  notes: CompileDiagnosticRef[];
}

/** compile.proto — BuilderResult (subset) */
export interface BuilderResult {
  build_path: string;
  diagnostics: CompileDiagnostic[];
}

/**
 * Shared streaming response shape for Compile and Upload. With `oneofs: true`
 * the active branch is named by the `message` discriminator; the other fields
 * are absent. Branch on `message`, never on truthiness (empty Buffers are falsy).
 */
export interface BuildStreamResponse {
  message: "out_stream" | "err_stream" | "progress" | "result";
  out_stream?: Buffer;
  err_stream?: Buffer;
  progress?: TaskProgress;
  result?: BuilderResult;
}

/** upload.proto — UploadResult */
export interface UploadResult {
  updated_upload_port?: Port;
}

/** upload.proto — UserField */
export interface UserField {
  tool_id: string;
  name: string;
  label: string;
  secret: boolean;
}

export interface SupportedUserFieldsResponse {
  user_fields: UserField[];
}

/** upload.proto — Programmer (subset) */
export interface Programmer {
  platform: string;
  id: string;
  name: string;
}

export interface ListProgrammersResponse {
  programmers: Programmer[];
}

/** monitor.proto — MonitorPortSettingDescriptor */
export interface MonitorPortSettingDescriptor {
  setting_id: string;
  label: string;
  type: string;
  enum_values: string[];
  value: string;
}

export interface EnumerateMonitorPortSettingsResponse {
  settings: MonitorPortSettingDescriptor[];
}

/**
 * monitor.proto — MonitorResponse (oneof error | rx_data | applied_settings | success).
 * Branch on `message`.
 */
export interface MonitorResponse {
  message: "error" | "rx_data" | "applied_settings" | "success";
  error?: string;
  rx_data?: Buffer;
  applied_settings?: { settings: { setting_id: string; value: string }[] };
  success?: boolean;
}
