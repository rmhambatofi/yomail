import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { signupSchema } from '../auth/schemas';
import { validateEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { DuplicateUserError, UsersService } from '../users/users.service';
import { UsersModule } from '../users/users.module';

/**
 * Account administration from the shell (compiled to dist/cli/user.js). The only
 * way to create an ADMIN: no API route creates or promotes one.
 *
 *   node dist/cli/user.js create-admin --username <u> --email <e> [--password <p>]
 *
 * Password source, in order: --password, YOMAIL_USER_PASSWORD, masked prompt on a
 * TTY (twice). Prefer the variable or the prompt: --password lands in the shell
 * history. The account is created ENABLED (no confirmation email).
 * Exit codes: 0 done, 1 error (validation, duplicate, database), 2 usage.
 */
const USAGE = `Usage:
  user.js create-admin --username <name> --email <address> [--password <secret>]

Creates an ENABLED user with the ADMIN role. Without --password, the password is read
from YOMAIL_USER_PASSWORD, or prompted (hidden) when running in a terminal.`;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    DatabaseModule,
    UsersModule,
  ],
})
class UserCliModule {}

interface ParsedArgs {
  command: string | undefined;
  options: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: undefined, options: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        parsed.options[key] = next;
        i += 1;
      } else {
        parsed.flags.add(key);
      }
    } else if (parsed.command === undefined) {
      parsed.command = arg;
    }
  }
  return parsed;
}

/**
 * Reads a line without echoing it. readline (terminal mode) redraws the whole line
 * through _writeToOutput on every keystroke and on each refresh, so the override
 * must print the prompt itself and swallow only the typed characters; muting
 * everything would also erase the prompt and leave a silent, blank line.
 */
export function promptHidden(
  question: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.input, output: io.output, terminal: true });
    const muted = rl as unknown as { _writeToOutput: (s: string) => void };
    muted._writeToOutput = (s: string) => {
      if (s.startsWith(question)) io.output.write(question);
    };
    rl.question(question, (answer) => {
      io.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function resolvePassword(options: Record<string, string>): Promise<string | null> {
  if (options.password !== undefined) return options.password;
  const fromEnv = process.env.YOMAIL_USER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'No password: set YOMAIL_USER_PASSWORD or pass --password (this shell is not an interactive terminal; in Git Bash/mintty try `winpty node ...`).',
    );
    return null;
  }
  console.log(
    'Password for the new admin (typed characters are hidden; or set YOMAIL_USER_PASSWORD).',
  );
  const first = await promptHidden('Password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) {
    console.error('Passwords do not match.');
    return null;
  }
  return first;
}

async function createAdmin(options: Record<string, string>): Promise<number> {
  const password = await resolvePassword(options);
  if (password === null) return 1;
  const parsed = signupSchema.safeParse({
    username: options.username ?? '',
    email: options.email ?? '',
    password,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.error(`Invalid ${issue.path.join('.') || 'input'}: ${issue.message}`);
    }
    return 1;
  }

  const app = await NestFactory.createApplicationContext(UserCliModule, { logger: ['error'] });
  try {
    const user = await app
      .get(UsersService)
      .create({ ...parsed.data, role: 'ADMIN', status: 'ENABLED' });
    console.log(`Admin user ${user.username} created (${user.id})`);
    return 0;
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      console.error(`That ${err.field} is already taken.`);
    } else {
      Logger.error(`create-admin failed: ${(err as Error).stack ?? err}`, 'user-cli');
    }
    return 1;
  } finally {
    await app.close();
  }
}

async function main(): Promise<number> {
  const { command, options, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('help') || command === undefined) {
    console.log(USAGE);
    return command === undefined && !flags.has('help') ? 2 : 0;
  }
  if (command === 'create-admin') return createAdmin(options);
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

// Only run when executed directly (tests import promptHidden without starting the CLI).
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
