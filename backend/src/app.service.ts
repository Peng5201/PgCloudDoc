import { Injectable } from '@nestjs/common';
import { testSheetData } from './component/sheetData';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getTestSheet(): any {
    return testSheetData;
  }
}
