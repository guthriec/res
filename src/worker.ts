import { startBackgroundFetcher } from './background-fetcher';

function parseDirArg(argv: string[]): string {
  const index = argv.indexOf('--dir');
  if (index !== -1 && argv[index + 1]) {
    return argv[index + 1];
  }
  return process.cwd();
}

const reservoirDir = parseDirArg(process.argv.slice(2));

startBackgroundFetcher(reservoirDir).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
