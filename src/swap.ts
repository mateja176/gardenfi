import { trim0x } from '@catalogfi/utils';
import { Quote, type SwapParams } from '@gardenfi/core';
import {
  type AdditionalDataWithStrategyId,
  type CreateOrderReqWithStrategyId,
  getTimeLock,
  isBitcoin,
  isMainnet,
} from '@gardenfi/orderbook';
import BigNumber from 'bignumber.js';
import { generateSecret } from './secretManager';
import { api, digestKey } from './utils';
import { Err, type Result } from '@gardenfi/utils';
import { auth } from './auth';
import { orderbook } from './orderbook';

export type SwapProps = SwapParams & {
  btcPublicKey: string;
  btcRecipientAddress: string;
  evmAddress: string;
};
export const swap = (
  props: SwapProps,
): Promise<
  Result<
    {
      orderId: string;
      secret: string;
    },
    string
  >
> => {
  const validatedProps = validateProps(props);
  if (!validatedProps.ok) {
    return Promise.resolve({ error: validatedProps.error, ok: false });
  }
  const {
    val: {
      additionalData: { strategyId },
      btcPublicKey,
      btcRecipientAddress,
      fromAsset,
      evmAddress,
      minDestinationConfirmations,
      receiveAmount,
      sendAmount,
      toAsset,
    },
  } = validatedProps;
  const timelock = getTimeLock(fromAsset.chain);

  const nonce = Date.now().toString();
  const secretResult = generateSecret({
    digestKey: digestKey.digestKey,
    nonce,
  });
  if (!secretResult.ok) {
    return Promise.resolve({ error: secretResult.error, ok: false });
  }
  const {
    val: { secret, secretHash },
  } = secretResult;
  const additionalData: AdditionalDataWithStrategyId['additional_data'] = {
    strategy_id: strategyId,
    ...(btcRecipientAddress && {
      bitcoin_optional_recipient: btcRecipientAddress,
    }),
  };
  const receiveAddress =
    (isBitcoin(toAsset.chain) && btcPublicKey) || evmAddress;
  const sendAddress =
    (isBitcoin(fromAsset.chain) && btcPublicKey) || evmAddress;
  const orderRequest: CreateOrderReqWithStrategyId = {
    additional_data: additionalData,
    destination_amount: receiveAmount,
    destination_asset: toAsset.atomicSwapAddress,
    destination_chain: toAsset.chain,
    fee: '1', // * placeholder
    initiator_destination_address: receiveAddress,
    initiator_source_address: sendAddress,
    min_destination_confirmations: minDestinationConfirmations ?? 0,
    nonce,
    secret_hash: trim0x(secretHash),
    source_amount: sendAmount,
    source_asset: fromAsset.atomicSwapAddress,
    source_chain: fromAsset.chain,
    timelock,
  };
  return new Quote(api.quote)
    .getAttestedQuote(orderRequest) // off chain agreement with a deadline for a quote with slashing for solvers
    .then((result) => {
      if (result.error) {
        return Err(result.error);
      }
      const { val: attestedQuote } = result;
      return orderbook
        .createOrder(attestedQuote, auth)
        .then((orderIdResult) => {
          if (orderIdResult.error) {
            return Err(orderIdResult.error);
          }
          const { val: orderId } = orderIdResult;
          return {
            ok: true,
            val: {
              orderId,
              secret,
            },
          };
        });
    });
};

export const validateProps = (
  props: SwapProps,
): Result<Omit<SwapProps, 'timelock'>, string> => {
  if (!props.additionalData.strategyId) {
    return { error: 'StrategyId is required', ok: false };
  }

  if (
    props.fromAsset.chain === props.toAsset.chain &&
    props.fromAsset.atomicSwapAddress === props.toAsset.atomicSwapAddress
  ) {
    return {
      error: 'Source and destination assets cannot be the same',
      ok: false,
    };
  }

  if (
    (isMainnet(props.fromAsset.chain) && !isMainnet(props.toAsset.chain)) ||
    (!isMainnet(props.fromAsset.chain) && isMainnet(props.toAsset.chain))
  ) {
    return {
      error:
        'Both assets should be on the same network (either mainnet or testnet)',
      ok: false,
    };
  }

  const inputAmount = validateAmount(props.sendAmount);
  if (inputAmount.error) {
    return { error: inputAmount.error, ok: false };
  }

  const outputAmount = validateAmount(props.receiveAmount);
  if (outputAmount.error) {
    return { error: outputAmount.error, ok: false };
  }

  if (inputAmount < outputAmount) {
    return {
      error: 'Send amount should be greater than receive amount',
      ok: false,
    };
  }

  if (
    (isBitcoin(props.fromAsset.chain) || isBitcoin(props.toAsset.chain)) &&
    !props.additionalData.btcAddress
  ) {
    return {
      error:
        'btcAddress in additionalData is required if source or destination chain is bitcoin, it is used as refund or redeem address.',
      ok: false,
    };
  }

  return { ok: true, val: props };
};

export const validateAmount = (amount: string): Result<BigNumber, string> => {
  const amountBigInt = new BigNumber(amount);
  if (
    !amountBigInt.isInteger() ||
    amountBigInt.isNaN() ||
    amountBigInt.isLessThanOrEqualTo(0)
  ) {
    return { error: 'Invalid amount ' + amount, ok: false };
  }
  return { ok: true, val: amountBigInt };
};
