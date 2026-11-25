# Legacy Discovery Fallback Specification

## Purpose

Pin the existing discovery fallback and its wake startup boundary without claiming support for a newer protocol lifecycle.

## ADDED Requirements

### Requirement: The client shall receive a method not found for discovery and complete the legacy handshake

The server SHALL retain the generic discovery error and the existing initialization lifecycle. The synthetic regression tests SHALL exercise that lifecycle without claiming a live third-party client has been checked.

#### Scenario: MCP-001 discovery answers generically and writes nothing

- **WHEN** a discovery request is handled before initialization
- **THEN** the response is the generic method-not-found error and no state is created

#### Scenario: MCP-002 fallback reaches tools and starts wake

- **GIVEN** an unacknowledged message exists before the connection
- **WHEN** a synthetic client falls back to initialize and sends the initialized notification
- **THEN** inbox tools are callable and exactly one body-free wake envelope identifies the message
- **AND** no wake is emitted before the initialized notification

#### Scenario: MCP-003 stdio frame order keeps the fallback

- **GIVEN** a wake notification may arrive before a response to a request
- **WHEN** a stdio client sends discovery, waits for its reply, and completes the legacy handshake and tool calls
- **THEN** the harness matches responses by request id, verifies their order and observes the intended body-free wake envelope

#### Scenario: MCP-004 a wake frame before a delayed reply is not the answer

- **GIVEN** the frame list contains a wake and does not contain the requested reply
- **WHEN** the reply is scheduled for a later event-loop turn
- **THEN** the reply helper waits for the requested id and leaves the wake frame intact
