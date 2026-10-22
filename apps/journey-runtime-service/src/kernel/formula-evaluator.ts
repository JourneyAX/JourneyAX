import type { CalculatorDefinition } from '@journeyax/business-pack';

export interface CalculatorExecutionResult {
  ok: boolean;
  calculatorId: string;
  calculatorName: string;
  missing?: string[];
  outputs?: Record<string, number | string>;
  message?: string;
  source?: string;
  verificationRef?: string;
  claimClass?: string;
}

/**
 * Token types for safe formula lexing.
 */
type TokenType = 'NUMBER' | 'IDENT' | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'PERCENT' | 'LPAREN' | 'RPAREN' | 'COMMA';

interface Token {
  type: TokenType;
  value: string;
  num?: number;
}

function tokenizeFormula(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '+') {
      tokens.push({ type: 'PLUS', value: '+' });
      i++;
    } else if (ch === '-') {
      tokens.push({ type: 'MINUS', value: '-' });
      i++;
    } else if (ch === '*') {
      tokens.push({ type: 'STAR', value: '*' });
      i++;
    } else if (ch === '/') {
      tokens.push({ type: 'SLASH', value: '/' });
      i++;
    } else if (ch === '%') {
      tokens.push({ type: 'PERCENT', value: '%' });
      i++;
    } else if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      i++;
    } else if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      i++;
    } else if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ',' });
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let numStr = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        numStr += expr[i];
        i++;
      }
      const num = parseFloat(numStr);
      if (isNaN(num)) throw new Error(`Invalid number format: "${numStr}"`);
      tokens.push({ type: 'NUMBER', value: numStr, num });
    } else if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }
      tokens.push({ type: 'IDENT', value: ident });
    } else {
      throw new Error(`Unexpected character in formula: "${ch}"`);
    }
  }
  return tokens;
}

class FormulaParser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly context: Record<string, number>
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(expected?: TokenType): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of formula');
    if (expected && token.type !== expected) {
      throw new Error(`Expected token ${expected} but found ${token.type} ("${token.value}")`);
    }
    this.pos++;
    return token;
  }

  public parse(): number {
    const result = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected extra tokens after formula: "${this.tokens[this.pos].value}"`);
    }
    return result;
  }

  private parseExpression(): number {
    let left = this.parseTerm();
    while (this.peek() && (this.peek()!.type === 'PLUS' || this.peek()!.type === 'MINUS')) {
      const op = this.consume().type;
      const right = this.parseTerm();
      if (op === 'PLUS') left += right;
      else left -= right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    while (
      this.peek() &&
      (this.peek()!.type === 'STAR' || this.peek()!.type === 'SLASH' || this.peek()!.type === 'PERCENT')
    ) {
      const op = this.consume().type;
      const right = this.parseUnary();
      if (op === 'STAR') {
        left *= right;
      } else if (op === 'SLASH') {
        if (right === 0) throw new Error('Division by zero in formula');
        left /= right;
      } else if (op === 'PERCENT') {
        if (right === 0) throw new Error('Modulo by zero in formula');
        left %= right;
      }
    }
    return left;
  }

  private parseUnary(): number {
    if (this.peek() && this.peek()!.type === 'MINUS') {
      this.consume('MINUS');
      return -this.parseUnary();
    }
    if (this.peek() && this.peek()!.type === 'PLUS') {
      this.consume('PLUS');
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (!token) throw new Error('Unexpected end of formula expression');

    if (token.type === 'NUMBER') {
      this.consume('NUMBER');
      return token.num!;
    }

    if (token.type === 'IDENT') {
      this.consume('IDENT');
      const name = token.value;

      // Function call (e.g. ceil, floor, round, max, min)
      if (this.peek()?.type === 'LPAREN') {
        this.consume('LPAREN');
        const args: number[] = [];
        if (this.peek()?.type !== 'RPAREN') {
          args.push(this.parseExpression());
          while (this.peek()?.type === 'COMMA') {
            this.consume('COMMA');
            args.push(this.parseExpression());
          }
        }
        this.consume('RPAREN');

        switch (name.toLowerCase()) {
          case 'ceil':
            return Math.ceil(args[0] ?? 0);
          case 'floor':
            return Math.floor(args[0] ?? 0);
          case 'round':
            return Math.round(args[0] ?? 0);
          case 'abs':
            return Math.abs(args[0] ?? 0);
          case 'max':
            return Math.max(...args);
          case 'min':
            return Math.min(...args);
          case 'sqrt':
            return Math.sqrt(args[0] ?? 0);
          default:
            throw new Error(`Unsupported math function: "${name}"`);
        }
      }

      // Variable lookup in context
      if (Object.prototype.hasOwnProperty.call(this.context, name)) {
        return this.context[name];
      }
      throw new Error(`Undefined variable in formula: "${name}"`);
    }

    if (token.type === 'LPAREN') {
      this.consume('LPAREN');
      const result = this.parseExpression();
      this.consume('RPAREN');
      return result;
    }

    throw new Error(`Unexpected token in formula: ${token.type} ("${token.value}")`);
  }
}

/**
 * Safely evaluates a mathematical formula expression against context variables without using eval().
 */
export function evaluateFormula(expression: string, context: Record<string, number>): number {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Formula expression must be a non-empty string');
  }
  const tokens = tokenizeFormula(expression);
  const parser = new FormulaParser(tokens, context);
  return parser.parse();
}

/**
 * Extracts and executes a data-defined calculator safely.
 * Returns { ok: false, missing: [...] } if any required input is missing (never defaults).
 */
export function executeCalculator(
  calculator: CalculatorDefinition,
  rawMeasurements: Record<string, any>
): CalculatorExecutionResult {
  const missingInputs: string[] = [];
  const context: Record<string, number> = {
    ...(calculator.constants || {}),
  };

  const measurements = rawMeasurements || {};

  // Normalize measurement keys (lowercase without underscores or spaces)
  const normKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const measMap = new Map<string, any>();
  for (const [k, v] of Object.entries(measurements)) {
    measMap.set(normKey(k), v);
  }

  // 1. Resolve inputs
  for (const input of calculator.inputs) {
    let resolvedVal: any = undefined;

    // Direct check
    if (Object.prototype.hasOwnProperty.call(measurements, input.name)) {
      resolvedVal = measurements[input.name];
    } else if (measMap.has(normKey(input.name))) {
      resolvedVal = measMap.get(normKey(input.name));
    }

    // Alias check
    if (resolvedVal === undefined && Array.isArray(input.aliases)) {
      for (const alias of input.aliases) {
        if (Object.prototype.hasOwnProperty.call(measurements, alias)) {
          resolvedVal = measurements[alias];
          break;
        } else if (measMap.has(normKey(alias))) {
          resolvedVal = measMap.get(normKey(alias));
          break;
        }
      }
    }

    if (resolvedVal !== undefined && resolvedVal !== null && resolvedVal !== '') {
      const num = Number(resolvedVal);
      if (isNaN(num)) {
        throw new Error(`Input "${input.name}" must be a numeric value, got: ${resolvedVal}`);
      }
      context[input.name] = num;
    } else if (input.required !== false) {
      missingInputs.push(input.name);
    }
  }

  // If required inputs are missing, fail open for clarification: return missing list, NEVER default!
  if (missingInputs.length > 0) {
    return {
      ok: false,
      calculatorId: calculator.calculatorId,
      calculatorName: calculator.name,
      missing: missingInputs,
      message: `Missing required measurements for ${calculator.name}: ${missingInputs.join(', ')}. Please ask the customer for these details.`,
    };
  }

  // 2. Execute formula steps in order
  for (const step of calculator.formulaSteps) {
    let stepVal = evaluateFormula(step.expression, context);
    if (step.round === 'ceil') stepVal = Math.ceil(stepVal);
    else if (step.round === 'floor') stepVal = Math.floor(stepVal);
    else if (step.round === 'round') stepVal = Math.round(stepVal);
    context[step.outputVar] = stepVal;
  }

  // 3. Assemble declared outputs
  const outputs: Record<string, number | string> = {};
  for (const out of calculator.outputs) {
    const val = context[out.varName];
    outputs[out.varName] = val !== undefined ? val : 0;
  }

  return {
    ok: true,
    calculatorId: calculator.calculatorId,
    calculatorName: calculator.name,
    outputs,
    source: calculator.source,
    verificationRef: calculator.verificationRef,
    claimClass: calculator.verificationRef ? (calculator.claimClass || 'verified_calculation') : undefined,
  };
}

/**
 * Finds a matching calculator from the pack or OKF release by project name or calculator ID.
 */
export function findMatchingCalculator(
  calculators: CalculatorDefinition[] | undefined | null,
  projectOrId: string
): CalculatorDefinition | undefined {
  if (!calculators || !Array.isArray(calculators) || calculators.length === 0) {
    return undefined;
  }
  const clean = (s?: string) => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const target = clean(projectOrId);

  return calculators.find((c) => {
    if (clean(c.calculatorId) === target) return true;
    if (clean(c.name) === target) return true;
    if (c.projectType && clean(c.projectType) === target) return true;
    if (Array.isArray(c.aliases) && c.aliases.some((a) => clean(a) === target || target.includes(clean(a)))) {
      return true;
    }
    return false;
  });
}
