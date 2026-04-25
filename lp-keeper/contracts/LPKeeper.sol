pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface INonfungiblePositionManager {

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    )
        external
        payable
        returns (
            uint256 amount0,
            uint256 amount1
        );

    function collect(
        CollectParams calldata params
    )
        external
        payable
        returns (
            uint256 amount0,
            uint256 amount1
        );

    function burn(uint256 tokenId)
        external
        payable;

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

contract LPKeeper {

    address public constant NPM =
        0xC36442b4a4522E871399CD717aBDD847Ab11FE88;

    address public constant WPOL =
        0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;

    address public constant USDC =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    uint24 public constant FEE = 500;

    address public owner;
    address public keeper;

    bool public paused;

    uint256 public tokenId;
    int24 public tickLower;
    int24 public tickUpper;
    uint128 public posLiquidity;

    uint256 public entryPriceRaw;
    uint256 public lastRebalanceTs;
    uint256 public rebalanceCount;

    uint256 public feeAccumulated0;
    uint256 public feeAccumulated1;

    uint256 public cooldownSeconds = 900;
    uint256 public maxRebalancesPerDay = 48;
    uint256 public dailyCount;
    uint256 public dailyResetTs;

    uint256 public keeperEthReserve = 0.002 ether;

    uint256 public slippageBps = 100;

    event PositionOpened(
        uint256 tokenId,
        int24 lower,
        int24 upper,
        uint128 liquidity
    );

    event Rebalanced(
        uint256 oldTokenId,
        uint256 newTokenId,
        int24 lower,
        int24 upper,
        uint256 timestamp
    );

    event FeesCollected(
        uint256 amount0,
        uint256 amount1
    );

    modifier onlyOwner {
        require(msg.sender==owner,"not owner");
        _;
    }

    modifier onlyKeeper {
        require(msg.sender==keeper,"not keeper");
        _;
    }

    modifier notPaused {
        require(!paused,"paused");
        _;
    }

    modifier cooldownPassed {
        require(
            block.timestamp >= lastRebalanceTs + cooldownSeconds,
            "cooldown"
        );
        _;
    }

    modifier dailyLimitOk {
        if(block.timestamp >= dailyResetTs + 1 days){
            dailyCount=0;
            dailyResetTs=block.timestamp;
        }

        require(
            dailyCount < maxRebalancesPerDay,
            "daily limit"
        );
        _;
    }

    modifier keeperHasGas {
        require(
            keeper.balance >= keeperEthReserve,
            "keeper low on POL"
        );
        _;
    }

    constructor(address _keeper){
        owner=msg.sender;
        keeper=_keeper;
        dailyResetTs=block.timestamp;
    }

    receive() external payable {}


    function openPosition(
        int24 _tickLower,
        int24 _tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 currentPrice
    )
        external
        onlyKeeper
        notPaused
        keeperHasGas
    {
        require(tokenId==0,"position exists");

        _validateTicks(
            _tickLower,
            _tickUpper
        );

        uint256 bal0=
            IERC20(WPOL).balanceOf(address(this));

        uint256 bal1=
            IERC20(USDC).balanceOf(address(this));

        uint256 amt0=
            amount0Desired>0
            ? _min(amount0Desired,bal0)
            : bal0;

        uint256 amt1=
            amount1Desired>0
            ? _min(amount1Desired,bal1)
            : bal1;

        (uint256 id,uint128 liq)=
            _mintPosition(
                _tickLower,
                _tickUpper,
                amt0,
                amt1
            );

        tokenId=id;
        posLiquidity=liq;
        tickLower=_tickLower;
        tickUpper=_tickUpper;

        entryPriceRaw=currentPrice;
        lastRebalanceTs=block.timestamp;
        rebalanceCount++;

        emit PositionOpened(
            id,
            _tickLower,
            _tickUpper,
            liq
        );
    }


    function rebalance(
        int24 newTickLower,
        int24 newTickUpper,
        uint256 currentPrice
    )
        external
        onlyKeeper
        notPaused
        cooldownPassed
        dailyLimitOk
        keeperHasGas
    {
        require(tokenId!=0,"no position");

        _validateTicks(
            newTickLower,
            newTickUpper
        );

        uint256 oldTokenId=tokenId;

        (uint256 c0,uint256 c1)=
            _collectAndBurnCurrentPosition();

        feeAccumulated0 += c0;
        feeAccumulated1 += c1;

        uint256 bal0=
            IERC20(WPOL).balanceOf(address(this));

        uint256 bal1=
            IERC20(USDC).balanceOf(address(this));

        (uint256 newTokenId,uint128 newLiquidity)=
            _mintPosition(
                newTickLower,
                newTickUpper,
                bal0,
                bal1
            );

        tokenId=newTokenId;
        posLiquidity=newLiquidity;

        tickLower=newTickLower;
        tickUpper=newTickUpper;

        entryPriceRaw=currentPrice;
        lastRebalanceTs=block.timestamp;

        rebalanceCount++;
        dailyCount++;

        emit FeesCollected(c0,c1);

        emit Rebalanced(
            oldTokenId,
            newTokenId,
            newTickLower,
            newTickUpper,
            block.timestamp
        );
    }


    function harvest()
        external
        onlyKeeper
    {
        require(tokenId!=0,"no position");

        (uint256 c0,uint256 c1)=
            INonfungiblePositionManager(NPM)
            .collect(
                INonfungiblePositionManager
                .CollectParams({
                    tokenId:tokenId,
                    recipient:address(this),
                    amount0Max:type(uint128).max,
                    amount1Max:type(uint128).max
                })
            );

        feeAccumulated0 += c0;
        feeAccumulated1 += c1;

        emit FeesCollected(c0,c1);
    }


    function _collectAndBurnCurrentPosition()
        internal
        returns(
            uint256 c0,
            uint256 c1
        )
    {
        (, , , , , , , uint128 liq, , , , )=
            INonfungiblePositionManager(NPM)
            .positions(tokenId);

        if(liq>0){
            INonfungiblePositionManager(NPM)
            .decreaseLiquidity(
                INonfungiblePositionManager
                .DecreaseLiquidityParams({
                    tokenId:tokenId,
                    liquidity:liq,
                    amount0Min:0,
                    amount1Min:0,
                    deadline:block.timestamp+5 minutes
                })
            );
        }

        (c0,c1)=
            INonfungiblePositionManager(NPM)
            .collect(
                INonfungiblePositionManager
                .CollectParams({
                    tokenId:tokenId,
                    recipient:address(this),
                    amount0Max:type(uint128).max,
                    amount1Max:type(uint128).max
                })
            );

        INonfungiblePositionManager(NPM)
            .burn(tokenId);

        tokenId=0;
    }


    function _mintPosition(
        int24 lower,
        int24 upper,
        uint256 amount0,
        uint256 amount1
    )
        internal
        returns(
            uint256 newTokenId,
            uint128 newLiquidity
        )
    {
        uint256 min0=
            amount0*(10000-slippageBps)/10000;

        uint256 min1=
            amount1*(10000-slippageBps)/10000;

        require(
            IERC20(WPOL).approve(
                NPM,
                amount0
            ),
            "approve WPOL failed"
        );

        require(
            IERC20(USDC).approve(
                NPM,
                amount1
            ),
            "approve USDC failed"
        );

        INonfungiblePositionManager.MintParams memory p;

        p.token0=WPOL;
        p.token1=USDC;
        p.fee=FEE;
        p.tickLower=lower;
        p.tickUpper=upper;
        p.amount0Desired=amount0;
        p.amount1Desired=amount1;
        p.amount0Min=min0;
        p.amount1Min=min1;
        p.recipient=address(this);
        p.deadline=block.timestamp+5 minutes;

        (newTokenId,newLiquidity,,)=
            INonfungiblePositionManager(NPM)
            .mint(p);
    }


    function setSlippageBps(
        uint256 bps
    )
        external
        onlyOwner
    {
        require(
            bps<=1000,
            "too high"
        );

        slippageBps=bps;
    }


    function _validateTicks(
        int24 lower,
        int24 upper
    )
        internal
        pure
    {
        require(lower<upper,"invalid ticks");

        require(
            lower%10==0,
            "tick lower bad"
        );

        require(
            upper%10==0,
            "tick upper bad"
        );
    }


    function _min(
        uint256 a,
        uint256 b
    )
        internal
        pure
        returns(uint256)
    {
        return a<b ? a:b;
    }

}