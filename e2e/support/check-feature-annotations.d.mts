// d1023: feature の注記の検査（check-feature-annotations.mjs）の型（試験から import するため）。
export interface FeatureAnnotation {
  track: string;
  verdict: 'pass' | 'fail';
  title: string;
}

export type ObservedResult = 'passed' | 'failed';

export interface ComparedAnnotation extends FeatureAnnotation {
  state: 'ok' | 'unknown' | 'mismatch';
  observed?: ObservedResult;
}

export function titlesFromReport(report: unknown): Map<string, ObservedResult>;
export function annotationsFromFeature(text: string): FeatureAnnotation[];
export function compareAnnotations(
  annotations: FeatureAnnotation[],
  observed: Map<string, ObservedResult>,
): ComparedAnnotation[];
