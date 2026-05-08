# Error Codes

All API errors throw `ReservoirError`, a subclass of `Error` with a `code` property. Catch by code to handle specific error types:

```typescript
import { ReservoirError, ErrorCodes } from "res-md";

try {
  await reservoir.fetchChannel("no-such-channel");
} catch (err) {
  if (err instanceof ReservoirError && err.code === ErrorCodes.CHANNEL_NOT_FOUND) {
    // handle missing channel
  }
}
```

## Error Code Reference

| Code | Description |
|------|-------------|
| `CHANNEL_NOT_FOUND` | The specified channel ID does not exist |
| `CONTENT_NOT_FOUND` | The specified content item ID does not exist |
| `CONTENT_FILE_NOT_FOUND` | The content item's markdown file is missing from disk |
| `UNABLE_TO_RESOLVE_FILE_PATH` | Could not determine the file path for a content item |
| `RESERVOIR_NOT_FOUND` | No initialized reservoir was found at the given path |
| `FETCHER_NOT_FOUND` | The custom fetcher executable was not found |
| `FETCHER_ALREADY_EXISTS` | A fetcher with the given name already exists |
| `INVALID_INPUT` | A parameter value was invalid (e.g., bad format, out of range) |
| `INVALID_RANGE` | A content ID range is malformed (e.g., `fromId` > `toId`) |
| `ID_NOT_FOUND` | A specific content ID referenced in a range was not found |
| `LOCK_TIMEOUT` | Timed out acquiring a content ID lock |
| `FETCH_FAILED` | An unexpected error occurred during fetch or content resolution |
