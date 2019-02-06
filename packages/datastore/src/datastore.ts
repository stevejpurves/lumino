/*-----------------------------------------------------------------------------
| Copyright (c) 2014-2018, PhosphorJS Contributors
|
| Distributed under the terms of the BSD 3-Clause License.
|
| The full license is in the file LICENSE, distributed with this software.
|----------------------------------------------------------------------------*/
import {
  IIterable, IIterator, iterValues, each, iterItems
} from '@phosphor/algorithm';

import {
  IMessageHandler, Message, MessageLoop
} from '@phosphor/messaging';

import {
  ISignal, Signal
} from '@phosphor/signaling';

import {
  Schema
} from './schema';

import {
  Table
} from './table';

import {
  createDuplexId
} from './utilities';


/**
 * A multi-user collaborative datastore.
 *
 * #### Notes
 * A store is structured in a maximally flat way using a hierarchy
 * of tables, records, and fields. Internally, the object graph is
 * synchronized among all users via CRDT algorithms.
 *
 * https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type
 * https://hal.inria.fr/file/index/docid/555588/filename/techreport.pdf
 */
export
class Datastore implements IIterable<Table<Schema>> {

  /**
   * Create a new datastore.
   *
   * @param id - The unique id of the datastore.
   * @param schemas - The table schemas of the datastore.
   */
  constructor(id: number, schemas: ReadonlyArray<Schema>) {
    this._context = {
      inTransaction: false,
      version: 0,
      storeId: id,
      change: {},
      patch: {},
    };
    this._tables = {};
    for (let s of schemas) {
      this._tables[s.id] = Table.create(s, this._context);
    }
  }

  /**
   * A signal emitted when changes are made to the store.
   *
   * #### Notes
   * This signal is emitted either at the end of a local mutation,
   * or after a remote mutation has been applied. The storeId can
   * be used to determine its source.
   *
   * The payload represents the set of local changes that were made
   * to bring the store to its current state.
   *
   * #### Complexity
   * `O(1)`
   */
  get changed(): ISignal<Datastore, Datastore.IChangedArgs> {
    return this._changed;
  }

  /**
   * The unique id of the store.
   *
   * #### Notes
   * The id is unique among all other collaborating peers.
   *
   * #### Complexity
   * `O(1)`
   */
  get id(): number {
    return this._context.storeId;
  }

  /**
   * The current version of the datastore.
   *
   * #### Notes
   * This version is automatically incremented for each
   * transaction to the store.
   *
   * #### Complexity
   * `O(1)`
   */
  get version(): number {
    return this._context.version;
  }

  /**
   * Create an iterator over all the tables of the datastore.
   *
   * @returns An iterator.
   */
  iter(): IIterator<Table<Schema>> {
    return iterValues(this._tables);
  }

  /**
   * Get the table for a particular schema.
   *
   * @param schema - The schema of interest.
   *
   * @returns The table for the specified schema.
   *
   * @throws An exception if no table exists for the given schema.
   *
   * #### Complexity
   * `O(log32 n)`
   */
  get<S extends Schema>(schema: S): Table<S> {
    return this._tables[schema.id] as Table<S>;
  }

  /**
   * Begin a new transaction in the store.
   *
   * @returns The id of the new transaction
   *
   * #### Notes
   * This will allow the state of the store to be mutated
   * thorugh the `update` method on the individual tables.
   *
   * After the updates are completed, `endTransaction` should
   * be called.
   */
  beginTransaction(): string {
    const id = createDuplexId(this.version, this.id);
    this._initTransaction(id);
    return id;
  }

  /**
   * Completes a transaction.
   *
   * #### Notes
   * This completes a transaction previously started with
   * `beginTransaction`. If a change has occurred, the
   * `changed` signal will be emitted.
   */
  endTransaction(): void {
    this._finalizeTransaction();
    if (this._context.change) {
      this._changed.emit({
        storeId: this.id,
        transactionId: this._currentTransactionId,
        type: 'transaction',
        change: this._context.change,
      });
    }
    if (this.transactionBroadcastHandler && this._context.patch) {
      MessageLoop.sendMessage(
        this.transactionBroadcastHandler,
        new Datastore.TransactionMessage({
          id: this._currentTransactionId,
          storeId: this.id,
          patch: this._context.patch,
      }));
    }
  }


  /**
   * Apply a transaction to the datastore.
   *
   * @param transaction - The data of the transaction.
   *
   * @returns A promise which resolves when the action is complete.
   *
   * @throws An exception if `apply` is called during a mutation.
   *
   * #### Notes
   * If changes are made, the `changed` signal will be emitted.
   */
  apply(transaction: Datastore.Transaction): void {
    const {storeId, patch} = transaction;

    this._initTransaction(transaction.id);

    const change: Datastore.MutableChange = {};
    each(iterItems(patch), ([schemaId, tablePatch]) => {
      change[schemaId] = Table.patch(this._tables[schemaId], tablePatch);
    });
    this._finalizeTransaction();
    this._changed.emit({
      storeId,
      transactionId: transaction.id,
      type: 'transaction',
      change,
    });
  }

  /**
   * Undo a patch that was previously applied.
   *
   * @param transactionId - The transaction to undo.
   *
   * @returns A promise which resolves when the action is complete.
   *
   * @throws An exception if `undo` is called during a mutation.
   *
   * #### Notes
   * If changes are made, the `changed` signal will be emitted before
   * the promise resolves.
   */
  undo(transactionId: string): Promise<void> {
    throw '';
  }

  /**
   * Redo a patch that was previously undone.
   *
   * @param transactionId - The transaction to redo.
   *
   * @returns A promise which resolves when the action is complete.
   *
   * @throws An exception if `redo` is called during a mutation.
   *
   * #### Notes
   * If changes are made, the `changed` signal will be emitted before
   * the promise resolves.
   */
  redo(transactionId: string): Promise<void> {
    throw '';
  }

  /**
   * An optional handler for broadcasting transactions to peers.
   */
  transactionBroadcastHandler: IMessageHandler | null = null;


  private _initTransaction(id: string): void {
    const context = this._context as Private.MutableContext;
    if (context.inTransaction) {
      throw new Error(`Already in a transaction: ${this._currentTransactionId}`);
    }
    context.inTransaction = true;
    context.change = {};
    context.patch = {};
    this._currentTransactionId = id;
  }

  private _finalizeTransaction(): void {
    const context = this._context as Private.MutableContext;
    if (!context.inTransaction) {
      throw new Error('No transaction in progress.');
    }
    context.version += 1;
    context.inTransaction = false;
  }

  private _tables: {[id: string]: Table<Schema>} = {};
  private _context: Datastore.Context;
  private _currentTransactionId: string;
  private _changed = new Signal<Datastore, Datastore.IChangedArgs>(this);
}


/**
 * The namespace for the `Datastore` class statics.
 */
export
namespace Datastore {

  /**
   * The arguments object for the store `changed` signal.
   */
  export
  interface IChangedArgs {
    /**
     * Whether the change was generated by transaction, undo, or redo.
     */
    readonly type: 'transaction' | 'undo' | 'redo';

    /**
     * The transaction id associated with the change.
     */
    readonly transactionId: string;

    /**
     * The id of the store responsible for the change.
     */
    readonly storeId: number;

    /**
     * A mapping of schema id to table change set.
     */
    readonly change: Change;
  }

  /**
   * A type alias for a store change.
   */
  export
  type Change = {
    readonly [schemaId: string]: Table.Change<Schema>;
  };

  /**
   * A type alias for a store patch.
   */
  export
  type Patch = {
    readonly [schemaId: string]: Table.Patch<Schema>;
  };

  /**
   * @internal
   */
  export
  type MutableChange = {
    [schemaId: string]: Table.MutableChange<Schema>;
  };

  /**
   * @internal
   */
  export
  type MutablePatch = {
    [schemaId: string]: Table.MutablePatch<Schema>;
  };

  /**
   * An object representing a datastore transaction.
   */
  export
  type Transaction = {

    /**
     * The id of the transaction.
     */
    readonly id: string;

    /**
     * The id of the store responsible for the transaction.
     */
    readonly storeId: number;

    /**
     * @param data - The patch data of the transaction.
     */
    readonly patch: Patch;
  }

  /**
   * A message of a datastore transaction.
   */
  export
  class TransactionMessage extends Message {
    constructor(transaction: Transaction) {
      super('datastore-transaction');
      this.transaction = transaction;
    }
    /**
     * The transaction associated with the change.
     */
    readonly transaction: Transaction;
  }

  /**
   * @internal
   */
  export
  type Context = Readonly<Private.MutableContext>;
}


namespace Private {
  export
  type MutableContext = {
    /**
     * Whether the datastore currently in a transaction.
     */
    inTransaction: boolean;

    /**
     * The current version of the datastore.
     */
    version: number;

    /**
     * The unique id of the datastore.
     */
    storeId: number;

    /**
     * The current change object of the transaction.
     */
    change: Datastore.MutableChange;

    /**
     * The current patch object of the transaction.
     */
    patch: Datastore.MutablePatch;
  }
}
