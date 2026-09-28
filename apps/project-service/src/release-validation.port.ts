export interface ReleaseValidationResult {
  passed: boolean;
  latestEvalSuiteResult?: any;
  error?: string;
}

export interface ReleaseValidationPort {
  validateRelease(
    projectId: string,
    businessPack: any,
    version: string | number
  ): Promise<ReleaseValidationResult>;
}
