import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

/** Optional ISO 8601 query parameter (`?before=2026-10-06T13:54:18.000Z`) → Date | null. */
@Injectable()
export class ParseIsoDatePipe implements PipeTransform<string | undefined, Date | null> {
  transform(value: string | undefined): Date | null {
    if (value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid date: ${value}`);
    }
    return date;
  }
}
