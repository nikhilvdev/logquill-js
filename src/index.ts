export { Level, levelName, parseLevel } from "./core/levels.js";
export type { LevelInput } from "./core/levels.js";

export { createRecord, utcTimestamp } from "./core/records.js";
export type { LogRecord } from "./core/records.js";

export { JSONFormatter } from "./core/formatter.js";
export type { Formatter } from "./core/formatter.js";

export type { Plugin, MiddlewareFunc } from "./core/plugin.js";
export { FunctionPlugin } from "./core/plugin.js";

export { ContextPlugin } from "./plugins/context-plugin.js";

export { RunPlugin } from "./plugins/run-plugin.js";
export type { RunPluginOptions } from "./plugins/run-plugin.js";

export {
  defaultResolveActiveOtelTraceId,
  generateTraceId,
  getTraceparent,
  parseTraceHeader,
  setTraceparent,
  TraceContextPlugin,
} from "./plugins/trace-context-plugin.js";
export type { TraceContextPluginOptions } from "./plugins/trace-context-plugin.js";

export { DEFAULT_REDACTED_KEYS, RedactPlugin } from "./plugins/redact-plugin.js";
export type { RedactPluginOptions } from "./plugins/redact-plugin.js";

export { DEFAULT_PII_PATTERNS, PIIRedactPlugin } from "./plugins/pii-redact-plugin.js";
export type { PIIRedactPluginOptions } from "./plugins/pii-redact-plugin.js";

export { SamplingPlugin } from "./plugins/sampling-plugin.js";
export type { SamplingPluginOptions } from "./plugins/sampling-plugin.js";

export { GENESIS_HASH, TamperEvidentPlugin } from "./plugins/tamper-evident-plugin.js";
export type { TamperEvidentPluginOptions } from "./plugins/tamper-evident-plugin.js";

export { AlertingPlugin } from "./plugins/alerting-plugin.js";
export type { AlertingPluginOptions } from "./plugins/alerting-plugin.js";

export { SlackAlertPlugin } from "./plugins/slack-alert-plugin.js";
export type { SlackAlertPluginOptions, SlackSender } from "./plugins/slack-alert-plugin.js";

export { PagerDutyAlertPlugin } from "./plugins/pagerduty-alert-plugin.js";
export type { PagerDutyAlertPluginOptions, PagerDutySender } from "./plugins/pagerduty-alert-plugin.js";

export { EmailAlertPlugin } from "./plugins/email-alert-plugin.js";
export type {
  EmailAlertPluginOptions,
  EmailMessage,
  EmailSender,
  NodemailerTransporterLike,
} from "./plugins/email-alert-plugin.js";

export { CollectingTransport, Transport } from "./transports/transport.js";

export { BatchingTransport } from "./transports/batching-transport.js";
export type { BatchingTransportOptions } from "./transports/batching-transport.js";

export { BaseSQLTransport } from "./transports/sql/base-sql-transport.js";
export type { BaseSQLTransportOptions, SQLLogRow } from "./transports/sql/base-sql-transport.js";

export { SQLiteTransport } from "./transports/sql/sqlite-transport.js";
export type {
  SQLiteClientLike,
  SQLiteStatementLike,
  SQLiteTransportOptions,
} from "./transports/sql/sqlite-transport.js";

export { PostgresTransport } from "./transports/sql/postgres-transport.js";
export type { PgClientLike, PostgresTransportOptions } from "./transports/sql/postgres-transport.js";

export { MySQLTransport } from "./transports/sql/mysql-transport.js";
export type { MySQLClientLike, MySQLTransportOptions } from "./transports/sql/mysql-transport.js";

export { MongoDBTransport } from "./transports/nosql/mongodb-transport.js";
export type {
  MongoClientLike,
  MongoCollectionLike,
  MongoDBTransportOptions,
} from "./transports/nosql/mongodb-transport.js";

export { DynamoDBTransport } from "./transports/nosql/dynamodb-transport.js";
export type {
  DynamoClientLike,
  DynamoLogItem,
  DynamoDBTransportOptions,
} from "./transports/nosql/dynamodb-transport.js";

export { RedisTransport } from "./transports/nosql/redis-transport.js";
export type { RedisClientLike, RedisTransportOptions } from "./transports/nosql/redis-transport.js";

export { BaseQueueTransport } from "./transports/queue/base-queue-transport.js";
export type { BaseQueueTransportOptions } from "./transports/queue/base-queue-transport.js";

export { KafkaTransport } from "./transports/queue/kafka-transport.js";
export type { KafkaProducerLike, KafkaTransportOptions } from "./transports/queue/kafka-transport.js";

export { RabbitMQTransport } from "./transports/queue/rabbitmq-transport.js";
export type { AmqpChannelLike, RabbitMQTransportOptions } from "./transports/queue/rabbitmq-transport.js";

export { SQSTransport } from "./transports/queue/sqs-transport.js";
export type { SQSClientLike, SQSTransportOptions } from "./transports/queue/sqs-transport.js";

export { PubSubTransport } from "./transports/queue/pubsub-transport.js";
export type { PubSubTopicLike, PubSubTransportOptions } from "./transports/queue/pubsub-transport.js";

export { CloudWatchTransport } from "./transports/cloud/cloudwatch-transport.js";
export type {
  CloudWatchClientLike,
  CloudWatchLogEvent,
  CloudWatchTransportOptions,
} from "./transports/cloud/cloudwatch-transport.js";

export { CloudLoggingTransport } from "./transports/cloud/cloud-logging-transport.js";
export type {
  CloudLoggingClientLike,
  CloudLoggingEntry,
  CloudLoggingTransportOptions,
} from "./transports/cloud/cloud-logging-transport.js";

export { AppInsightsTransport } from "./transports/cloud/app-insights-transport.js";
export type {
  AppInsightsClientLike,
  AppInsightsTrace,
  AppInsightsTransportOptions,
} from "./transports/cloud/app-insights-transport.js";

export { DatadogTransport } from "./transports/cloud/datadog-transport.js";
export type { DatadogSender, DatadogTransportOptions } from "./transports/cloud/datadog-transport.js";

export { ElasticsearchTransport } from "./transports/cloud/elasticsearch-transport.js";
export type {
  ElasticsearchSender,
  ElasticsearchTransportOptions,
} from "./transports/cloud/elasticsearch-transport.js";

export { NewRelicTransport } from "./transports/cloud/new-relic-transport.js";
export type {
  NewRelicRegion,
  NewRelicSender,
  NewRelicSenderResult,
  NewRelicTransportOptions,
} from "./transports/cloud/new-relic-transport.js";

export { ConsoleTransport } from "./transports/console-transport.js";
export type { ConsoleLike, ConsoleTransportOptions } from "./transports/console-transport.js";

export { FileTransport } from "./transports/file-transport.js";
export type { FileTransportOptions } from "./transports/file-transport.js";

export { HTTPTransport } from "./transports/http-transport.js";
export type { HTTPTransportOptions, Sender } from "./transports/http-transport.js";

export { Logger } from "./core/logger.js";
export type { LoggerOptions, SpanOptions } from "./core/logger.js";

export const VERSION = "0.3.0";
