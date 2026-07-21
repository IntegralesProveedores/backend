import { RouteContext } from "../lib/router";
import { errorResponse, jsonResponse } from "../lib/response";

interface WebhookRequestLog {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  query_params: Record<string, string[]>;
  body: string;
}

function getHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function getQueryParams(url: URL): Record<string, string[]> {
  const queryParams: Record<string, string[]> = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = [...(queryParams[key] ?? []), value];
  });
  return queryParams;
}

export async function handleMercadoPagoWebhook({ request, url }: RouteContext): Promise<Response> {
  try {
    const body = await request.text();
    const webhookLog: WebhookRequestLog = {
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      headers: getHeaders(request),
      query_params: getQueryParams(url),
      body
    };

    console.log("Mercado Pago webhook received", JSON.stringify(webhookLog));

    return jsonResponse({
      success: true,
      message: "Webhook received"
    });
  } catch (error: unknown) {
    const errorDetails = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
          cause: error.cause
        }
      : { value: String(error) };

    console.error("Mercado Pago webhook error", JSON.stringify({
      timestamp: new Date().toISOString(),
      error: errorDetails
    }));

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return errorResponse(`Mercado Pago webhook error: ${message}`, 500, {
      stack,
      error: errorDetails
    });
  }
}
