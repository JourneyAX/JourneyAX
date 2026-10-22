import { z } from 'zod';

export const CalculatorInputSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  unit: z.string().optional(),
  required: z.boolean().default(true),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const CalculatorFormulaStepSchema = z.object({
  outputVar: z.string(),
  expression: z.string(),
  label: z.string().optional(),
  round: z.enum(['ceil', 'floor', 'round', 'none']).optional(),
});

export const CalculatorOutputSchema = z.object({
  varName: z.string(),
  label: z.string(),
  unit: z.string().optional(),
});

export const CalculatorDefinitionSchema = z.object({
  calculatorId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  projectType: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  inputs: z.array(CalculatorInputSchema),
  constants: z.record(z.string(), z.number()).optional(),
  formulaSteps: z.array(CalculatorFormulaStepSchema),
  outputs: z.array(CalculatorOutputSchema),
  source: z.string().optional(),
  verificationRef: z.string().optional(),
  claimClass: z.string().optional(),
});

export type CalculatorInput = z.infer<typeof CalculatorInputSchema>;
export type CalculatorFormulaStep = z.infer<typeof CalculatorFormulaStepSchema>;
export type CalculatorOutput = z.infer<typeof CalculatorOutputSchema>;
export type CalculatorDefinition = z.infer<typeof CalculatorDefinitionSchema>;
