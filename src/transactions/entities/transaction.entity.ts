import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export enum TransactionStatus {
  AUTHORIZED = 'AUTHORIZED',
  CONFIRMED = 'CONFIRMED',
  VOIDED = 'VOIDED',
}

@Entity('transactions')
@Unique('uq_terminal_nsu', ['terminalId', 'nsu'])
@Index('idx_transactions_status_created', ['status', 'createdAt'])
export class Transaction {
  @PrimaryColumn('varchar', { length: 26, name: 'transaction_id' })
  transactionId!: string;

  @Column('varchar', { length: 50, name: 'terminal_id' })
  terminalId!: string;

  @Column('varchar', { length: 50 })
  nsu!: string;

  @Column('numeric', { precision: 15, scale: 2 })
  amount!: string;

  @Column('varchar', { length: 3, default: 'BRL' })
  currency!: string;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
  })
  status!: TransactionStatus;

  @Column('varchar', {
    length: 100,
    nullable: true,
    name: 'external_auth_code',
  })
  externalAuthCode!: string | null;

  @Column('varchar', {
    length: 100,
    nullable: true,
    name: 'external_transaction_id',
  })
  externalTransactionId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column('timestamptz', { nullable: true, name: 'confirmed_at' })
  confirmedAt!: Date | null;

  @Column('timestamptz', { nullable: true, name: 'voided_at' })
  voidedAt!: Date | null;

  @VersionColumn()
  version!: number;
}
