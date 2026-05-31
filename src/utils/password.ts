// Password strength validator.
// Rationale: app stores clinical PII (LGPD art. 11 — dados sensíveis).
// 6-char minimum is insufficient. Requires 10+ chars with mixed character classes.

const MIN_LENGTH = 10;

export interface PasswordCheck {
  valid: boolean;
  error?: string;
}

export function validatePassword(password: string): PasswordCheck {
  if (password.length < MIN_LENGTH) {
    return {
      valid: false,
      error: `A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`,
    };
  }

  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);

  const missing: string[] = [];
  if (!hasLower) missing.push('letra minúscula');
  if (!hasUpper) missing.push('letra maiúscula');
  if (!hasDigit) missing.push('número');

  if (missing.length > 0) {
    return {
      valid: false,
      error: `A senha precisa conter: ${missing.join(', ')}.`,
    };
  }

  return { valid: true };
}

export const PASSWORD_REQUIREMENTS_HINT =
  `Mínimo ${MIN_LENGTH} caracteres, com maiúscula, minúscula e número.`;
