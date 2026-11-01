/**
 * 回归：全局 ValidationPipe 开了 enableImplicitConversion，
 * `unknown[]` 的元素会被 class-transformer 转成空数组。DTO 必须显式声明元素类型。
 */

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AiTurnRequestDto } from './ai.dto';

describe('AiTurnRequestDto', () => {
    it('保留 tools / results 里的对象结构', async () => {
        const dto = plainToInstance(AiTurnRequestDto, {
            requestId: 'req-1',
            input: {
                type: 'tool_results',
                results: [
                    {
                        toolCallId: 'call-1',
                        name: 'read_range',
                        ok: true,
                        result: { values: [[1]] },
                    },
                ],
            },
            context: { documentId: 'doc-1' },
            tools: [
                {
                    name: 'read_range',
                    description: '读取区域',
                    parameters: { type: 'object', properties: {} },
                },
            ],
        });

        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
        expect(dto.tools[0]).toMatchObject({ name: 'read_range' });
        expect(dto.input.results?.[0]).toMatchObject({ toolCallId: 'call-1' });
    });
});
