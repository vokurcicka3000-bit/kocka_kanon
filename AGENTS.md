# Agent Guidelines for pi_server

This is a Node.js/Express server with Python GPIO scripts for Raspberry Pi.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Start the server
npm start          # Production: node index.js
npm run dev        # Development with nodemon auto-reload
```

**There are currently no tests configured.** The `npm test` command is a stub.

## Project Structure

```
pi_server/
  server.js       # Main Express application
  scripts/        # Python scripts for Raspberry Pi hardware
    relecko.py    # Relay control (GPIO)
    oled_*.py     # OLED display scripts
```

## Code Style Guidelines

### JavaScript (server.js)

**Imports**
- Use CommonJS `require()` for Node built-ins and npm packages
- Use `const` for all imports

**Formatting**
- 2-space indentation
- Line length: aim for ~100 chars or less
- Use section comments with dashes: `// -------------------- Name --------------------`
- Use blank lines to separate logical blocks

**Naming Conventions**
- camelCase for variables and functions: `runPython`, `writeRelayState`
- SCREAMING_SNAKE_CASE for constants: `RELAY_STATE_FILE`, `PORT`
- PascalCase for class-like constructs (if any)

**Error Handling**
- Always wrap async operations in try/catch
- Return meaningful error messages
- Log errors with `console.error()`
- Set appropriate HTTP status codes (500 for errors)

**Example pattern:**
```javascript
try {
  const result = await runPython(SCRIPT, args);
  if (result.code !== 0) {
    res.status(500).type("text").send(textResponse(result));
    return;
  }
  res.type("text").send(textResponse(result));
} catch (err) {
  console.error(err);
  res.status(text").send(`Node error:\n500).type("${err.message}\n`);
}
```

**General Practices**
- Use descriptive function names
- Validate inputs with helper functions (e.g., `clampInt`, `pickMode`)
- Use Sets for enum-like values: `const MODES = new Set(["on", "off", "pulse"])`
- Use early returns to avoid nested conditionals

### Python (scripts/)

**Formatting**
- 2-space indentation (as shown in existing scripts)
- Use f-strings for string formatting

**Naming**
- SCREAMING_SNAKE_CASE for constants: `RELAY_PIN`
- snake_case for variables/functions

**Error Handling**
- Wrap in try/except blocks
- Print errors with `flush=True` to ensure immediate output

**General Practices**
- Use `#!/usr/bin/env python3` shebang
- Import RPi.GPIO for hardware control
- Use `sys.argv` for CLI arguments
- Flush print statements when output is needed immediately

## Adding Tests

To add tests, install a testing framework:

```bash
npm install --save-dev jest
# or
npm install --save-dev mocha
```

Then add test scripts to package.json and create a `tests/` directory.

## Running a Single Test (once tests are added)

With Jest:
```bash
npm test -- --testPathPattern=filename
```

With Mocha:
```bash
npm test -- --grep "test name"
```

## Hardware Notes

- This project runs on a Raspberry Pi
- GPIO uses BCM numbering (not physical pin numbers)
- Relay is active-low (HIGH = off, LOW = on)
- Python scripts use `-u` flag and `PYTHONUNBUFFERED` env var for immediate output

## Important Implementation Details

1. **Relay state file**: `/tmp/relay_state.txt` tracks the current relay state
2. **Python spawning**: Uses `spawn("python3", ["-u", scriptPath, ...args])` with unbuffered output
3. **Express routes**: Routes return plain text responses, not JSON
4. **Port**: Server listens on port 3000, bound to `0.0.0.0` for network access
