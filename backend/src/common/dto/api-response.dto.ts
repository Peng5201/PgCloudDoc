/**
 * 统一响应体。
 *
 * 成功：{ success: true,  data, requestId }
 * 失败：{ success: false, code, message, details?, requestId }
 *
 * 为什么所有接口都要包一层：客户端只需写一个 `unwrap()`，
 * 任何接口的成功/失败形态都一致，不用每个请求都判断字段在不在。
 */

export interface ApiSuccess<T> {
    success: true;
    data: T;
    requestId: string;
}

export interface ApiFailure {
    success: false;
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiSuccess<T>(res: ApiResponse<T>): res is ApiSuccess<T> {
    return res.success;
}
