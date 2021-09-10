import { DatabaseError as DBError } from 'pg';
import DatabaseError from './DatabaseError';

export default class UpdateError extends DatabaseError {
    constructor(message: string);

    constructor(error: DBError);

    constructor(error: DBError, message: string);

    constructor(error?: DBError | string, message?: string) {
        super(error, message);
        this.name = DatabaseError.UPDATE_ERROR;
    }
}
