export type DiagnosticLogValue = string | number | boolean | undefined;
export type DiagnosticLogFields = Readonly<Record<string, DiagnosticLogValue>>;

export interface DiagnosticLogger {
  debug(event: string, fields?: DiagnosticLogFields): void;
  info(event: string, fields?: DiagnosticLogFields): void;
  warn(event: string, fields?: DiagnosticLogFields): void;
  error(event: string, fields?: DiagnosticLogFields): void;
}

export interface DiagnosticLogSink {
  appendLine(value: string): void;
}

export class OutputChannelDiagnosticLogger implements DiagnosticLogger {
  public constructor(private readonly sink: DiagnosticLogSink) {}

  public debug(event: string, fields?: DiagnosticLogFields): void {
    this.write("DEBUG", event, fields);
  }

  public info(event: string, fields?: DiagnosticLogFields): void {
    this.write("INFO", event, fields);
  }

  public warn(event: string, fields?: DiagnosticLogFields): void {
    this.write("WARN", event, fields);
  }

  public error(event: string, fields?: DiagnosticLogFields): void {
    this.write("ERROR", event, fields);
  }

  private write(level: string, event: string, fields?: DiagnosticLogFields): void {
    const safeFields = Object.entries(fields ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    const suffix =
      safeFields.length === 0 ? "" : ` ${JSON.stringify(Object.fromEntries(safeFields))}`;
    this.sink.appendLine(`[diagnostic] ${new Date().toISOString()} ${level} ${event}${suffix}`);
  }
}
