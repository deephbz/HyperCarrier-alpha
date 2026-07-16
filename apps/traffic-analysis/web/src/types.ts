import type {
  Aggregate,
  AnalysisEnvelope,
  AnalysisRow,
} from "../../src/domain/contracts";
export type { Aggregate, AnalysisEnvelope, AnalysisRow };
export type Row = AnalysisRow & Record<string, unknown>;
export const rowsOf = (data: AnalysisEnvelope, kind: string): Row[] =>
  data.rows.filter((row) => row.row_type === kind) as Row[];
export const field = <T>(row: Row, key: string): T | undefined =>
  row[key] as T | undefined;
