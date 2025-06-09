// import SqliteDb from 'better-sqlite3'
import { Kysely, Migrator, SqliteDialect, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { DatabaseSchema } from './schema'
import { migrationProvider } from './migrations'

export const createDb = (location: string): Database => {
  // if (location.startsWith('postgres://')) {
  const pool = new Pool({ connectionString: location })
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  })
  // } else {
  //   return new Kysely<DatabaseSchema>({
  //     dialect: new SqliteDialect({
  //       database: new SqliteDb(location),
  //     }),
  //   })
  // }
}

export const migrateToLatest = async (db: Database) => {
  const migrator = new Migrator({ db, provider: migrationProvider })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}

export type Database = Kysely<DatabaseSchema>
