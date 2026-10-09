import { Controller, Get, Header } from '@nestjs/common';

import { Metrics } from '@/infrastructure/observability/metrics';
import { Public } from '@/infrastructure/auth/auth.guard';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
