import {Block, Effect, IndexState, Updater} from "../../../index"

export default abstract class AbstractActionHandler {
  protected lastProcessedBlockNumber: number = 0
  protected lastProcessedBlockHash: string = ""

  constructor(
    protected updaters: Updater[],
    protected effects: Effect[],
  ) {
  }

  public abstract async loadIndexState(): Promise<IndexState>

  /**
   * Receive block, validate, and handle actions with updaters and effects
   * @param {Block} block
   * @param {boolean} isRollback
   * @param {boolean} isFirstBlock
   * @param {boolean} isReplay
   * @returns {Promise<[boolean, number]>}
   */
  public async handleBlock(
    block: Block,
    isRollback: boolean,
    isFirstBlock: boolean,
    isReplay: boolean = false,
  ): Promise<[boolean, number]> {
    if (isRollback) {
      await this.rollbackTo(block.blockNumber - 1)
    }

    if (!this.lastProcessedBlockHash && this.lastProcessedBlockNumber !== 0) {
      const { blockNumber: indexStateBlockNumber, blockHash: indexStateBlockHash } = await this.loadIndexState()
      if (indexStateBlockNumber && indexStateBlockHash) {
        this.lastProcessedBlockNumber = indexStateBlockNumber
        this.lastProcessedBlockHash = indexStateBlockHash
      }
    }

    const nextBlockNeeded = this.lastProcessedBlockNumber + 1

    // Just processed this block; skip
    if (block.blockNumber === this.lastProcessedBlockNumber
        && block.blockHash === this.lastProcessedBlockHash) {
      return [false, 0]
    }

    // If it's the first block but we've already processed blocks, seek to next block
    if (isFirstBlock && this.lastProcessedBlockHash) {
      return [true, nextBlockNeeded]
    }
    // Only check if this is the block we need if it's not the first block
    if (!isFirstBlock) {
      if (block.blockNumber !== nextBlockNeeded) {
        return [true, nextBlockNeeded]
      }
      // Block sequence consistency should be handled by the ActionReader instance
      if (block.previousBlockHash !== this.lastProcessedBlockHash) {
        throw Error("Block hashes do not match; block not part of current chain.")
      }
    }

    const handleWithArgs: (state: any, context?: any) => void = async (state: any, context: any = {}) => {
      await this.handleActions(state, block, context, isReplay)
    }
    await this.handleWithState(handleWithArgs)
    return [false, 0]
  }

  protected abstract async updateIndexState(state: any, block: Block, context?: any): Promise<void>

  /**
   * Calls handleActions with the appropriate state using the passed in handle function
   * @param {(state: any) => void} handle
   */
  protected abstract async handleWithState(handle: (state: any, context?: any) => void): Promise<void>

  /**
   * Process actions against deterministically accumulating updater functions.
   * @param {any} state
   * @param {Block} block
   * @param {any} context
   */
  protected async runUpdaters(
    state: any,
    block: Block,
    context: any,
  ): Promise<void> {
    const { actions, ...blockInfo } = block
    for (const action of actions) {
      for (const updater of this.updaters) {
        if (action.type === updater.actionType) {
          const { payload } = action
          await updater.updater(state, payload, blockInfo, context)
        }
      }
    }
  }

  /**
   * Process actions against asynchronous side effects.
   * @param {any} state
   * @param {Block} block
   * @param {any} context
   */
  protected runEffects(
    state: any,
    block: Block,
    context: any,
  ): void {
    const { actions, ...blockInfo } = block
    for (const action of actions) {
      for (const effect of this.effects) {
        if (action.type === effect.actionType) {
          const { payload } = action
          effect.effect(state, payload, blockInfo, context)
        }
      }
    }
  }

  /**
   * Will run when a rollback block number is passed to handleActions. Implement this method to
   * handle reversing actions full blocks at a time, until the last applied block is the block
   * number passed to this method. If replay is true, effects should not be processed
   *
   * @param {number} blockNumber
   * @returns {Promise<void>}
   */
  protected abstract async rollbackTo(blockNumber: number): Promise<void>

  /**
   * Calls runUpdaters and runEffects on the given actions
   * @param {any} state
   * @param {Block} block
   * @param {any} context
   * @param {boolean} isReplay
   */
  protected async handleActions(
    state: any,
    block: Block,
    context: any,
    isReplay: boolean,
  ): Promise<void> {

    await this.runUpdaters(state, block, context)
    if (!isReplay) {
      this.runEffects(state, block, context)
    }

    await this.updateIndexState(state, block, context)
    this.lastProcessedBlockNumber = block.blockNumber
    this.lastProcessedBlockHash = block.blockHash
  }
}
