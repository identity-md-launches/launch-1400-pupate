// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SeaportInterface} from "seaport-types/src/interfaces/SeaportInterface.sol";
import {ZoneInterface} from "seaport-types/src/interfaces/ZoneInterface.sol";
import {ItemType, OrderType} from "seaport-types/src/lib/ConsiderationEnums.sol";
import {
    AdvancedOrder,
    ConsiderationItem,
    CriteriaResolver,
    Order,
    OrderComponents,
    OrderParameters,
    Schema,
    ZoneParameters
} from "seaport-types/src/lib/ConsiderationStructs.sol";
import {Cocoon} from "../../src/Cocoon.sol";
import {FloorFeed} from "../../src/FloorFeed.sol";
import {IERC20Minimal} from "../../src/interfaces/IERC20Minimal.sol";
import {IERC721Minimal} from "../../src/interfaces/IERC721Minimal.sol";
import {OracleAttestation} from "../../src/oracle/OracleAttestation.sol";
import {SeatListing} from "../../src/cocoon/SeatListing.sol";
import {MockERC721} from "../mocks/MockERC721.sol";

/// @dev A zone that approves every order, so a FULL_RESTRICTED listing fulfils on the live Seaport.
/// The magic values are the interface's own selectors, which is exactly what Seaport compares against.
contract PermissiveZone is ZoneInterface {
    function authorizeOrder(ZoneParameters calldata) external pure returns (bytes4) {
        return ZoneInterface.authorizeOrder.selector;
    }

    function validateOrder(ZoneParameters calldata) external pure returns (bytes4) {
        return ZoneInterface.validateOrder.selector;
    }

    function getSeaportMetadata() external pure returns (string memory name, Schema[] memory schemas) {
        return ("PermissiveZone", schemas);
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @dev Runs only with MAINNET_RPC_URL set. Proves Cocoon against the live Seaport 1.6 and the
/// live collection: buys a real listing, publishes its two orders, and sells through the falling
/// one. This is the gate for Plan 4.
contract CocoonSeaportForkTest is Test {
    address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    address constant COLLECTION = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D;
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant IMD = 0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7;
    uint256 constant SEAT = 1376;
    uint256 constant ATTESTER_KEY = 0xA11CE;
    bytes32 constant QUESTION = keccak256("floor question");

    bool ready;
    uint256 strayWei; // ETH already sitting on the fork at Cocoon's deploy address; `skim` books it
    FloorFeed feed;
    Cocoon cocoon;
    IERC721Minimal collection = IERC721Minimal(COLLECTION);
    SeaportInterface seaport = SeaportInterface(SEAPORT);
    address owner = makeAddr("timelock");
    address keeper = makeAddr("keeper");
    address buyer = makeAddr("buyer");
    CriteriaResolver[] noResolvers;

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        ready = true;

        feed = new FloorFeed(owner, vm.addr(ATTESTER_KEY), 1);
        vm.prank(owner);
        feed.setQuestion(QUESTION);
        cocoon = new Cocoon(
            owner,
            makeAddr("developer"),
            makeAddr("operator"),
            collection,
            seaport,
            IPoolManager(POOL_MANAGER),
            feed,
            IERC20Minimal(IMD)
        );
        strayWei = address(cocoon).balance;
        vm.deal(keeper, 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(address(this), 100 ether);
    }

    function test_buysARealListingPublishesItsOrdersAndSellsThroughOne() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        OrderParameters memory listing = _holderLists(holder, 2.8 ether);

        _report(2.8 ether);
        cocoon.depositTax{value: 10 ether}();
        uint256 holderBefore = holder.balance;

        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(listing, 1, 1, "", ""), noResolvers);

        assertEq(collection.ownerOf(SEAT), address(cocoon));
        assertEq(holder.balance, holderBefore + 2.8 ether);
        (uint128 cost,,,,, bool held,) = cocoon.seats(SEAT);
        assertEq(cost, 2.8 ether);
        assertTrue(held);
        _assertOurOrdersAreValidated();

        // A week later a buyer takes the falling order at its current price.
        vm.warp(block.timestamp + 7 days);
        uint256 burnBefore = cocoon.burnPot();
        _buyerTakesTheFallingOrder();
        assertEq(collection.ownerOf(SEAT), buyer);
        assertGt(cocoon.burnPot(), burnBefore + 3.6 ether);

        cocoon.settleSeat(SEAT);
        assertEq(cocoon.heldCount(), 0);
        _assertTheTailIsCancelled();
    }

    // ------------------------------------------------------------------ hardening (Plan 4)

    /// A listing that falls over its window. Cocoon sends the ceiling (the start amount); Seaport
    /// takes the current, lower price and refunds the rest, which stays unspent in the seat pot.
    function test_refundFromAFallingOrderStaysInTheSeatPot() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        // Falls from 2.88 to 2.4 ETH over 7 days.
        OrderParameters memory listing = _holderListsTerms(
            holder, SeatListing.Terms(2.4 ether, 12_000, 10_000, 7 days, uint40(block.timestamp), 0)
        );
        uint256 ceiling = 2.88 ether;

        vm.warp(block.timestamp + 3.5 days);
        _report(2.8 ether); // 2.88 is within the 5% tolerance of 2.8
        cocoon.depositTax{value: 10 ether}();

        uint256 holderBefore = holder.balance;
        uint256 potBefore = cocoon.seatPot();
        uint256 burnBefore = cocoon.burnPot();

        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(listing, 1, 1, "", ""), noResolvers);

        (uint128 cost,,,,, bool held,) = cocoon.seats(SEAT);
        uint256 spent = holder.balance - holderBefore;
        uint256 reward = spent * cocoon.getParams().callerRewardBps / 10_000;
        assertTrue(held);
        assertEq(cost, spent, "cost is exactly what Seaport paid out");
        assertLt(spent, ceiling, "the order took less than the ceiling we sent");
        assertGe(spent, 2.4 ether, "and at least its floor");
        assertEq(cocoon.seatPot(), potBefore - spent - reward, "only the spend and reward leave the seat pot");
        assertEq(cocoon.burnPot(), burnBefore, "the refund is not booked as proceeds");
        _assertBalanceIdentity();
        _assertOurOrdersAreValidated();
    }

    /// OpenSea splits the price across the seller and a fee recipient. Neither is Cocoon, so the
    /// order is accepted and the cost is the sum paid to both.
    function test_twoItemConsiderationIsAcceptedAndCostIsTheSum() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        address fee = makeAddr("marketplace fee");
        OrderParameters memory p = _flatParams(holder, 2.8 ether);
        ConsiderationItem[] memory c = new ConsiderationItem[](2);
        c[0] = _native(2.1 ether, holder);
        c[1] = _native(0.7 ether, fee); // 2.8 ETH split 75/25
        p.consideration = c;
        p.totalOriginalConsiderationItems = 2;
        _validateAs(holder, p);

        _report(2.8 ether);
        cocoon.depositTax{value: 10 ether}();
        uint256 holderBefore = holder.balance;

        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(p, 1, 1, "", ""), noResolvers);

        assertEq(collection.ownerOf(SEAT), address(cocoon));
        (uint128 cost,,,,,,) = cocoon.seats(SEAT);
        assertEq(cost, 2.8 ether);
        assertEq(holder.balance, holderBefore + 2.1 ether);
        assertEq(fee.balance, 0.7 ether);
        _assertBalanceIdentity();
    }

    /// A well-formed FULL_RESTRICTED (zoned) listing, as `_checkOrder` allows, fulfils against the
    /// live Seaport when its zone approves.
    function test_fullRestrictedOrderIsAccepted() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        PermissiveZone zone = new PermissiveZone();
        OrderParameters memory p = _flatParams(holder, 2.8 ether);
        p.orderType = OrderType.FULL_RESTRICTED;
        p.zone = address(zone);
        _validateAs(holder, p);

        _report(2.8 ether);
        cocoon.depositTax{value: 10 ether}();
        uint256 holderBefore = holder.balance;

        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(p, 1, 1, "", ""), noResolvers);

        assertEq(collection.ownerOf(SEAT), address(cocoon));
        (uint128 cost,,,,, bool held,) = cocoon.seats(SEAT);
        assertEq(cost, 2.8 ether);
        assertTrue(held);
        assertEq(holder.balance, holderBefore + 2.8 ether);
        _assertOurOrdersAreValidated();
    }

    /// A fulfiller tip (an extra consideration item beyond the original, or one paid to Cocoon) is
    /// refused by `_checkOrder` before Seaport is ever touched.
    function test_fulfillerTipIsRefused() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        _report(2.8 ether);
        cocoon.depositTax{value: 10 ether}();

        // An item appended past totalOriginalConsiderationItems (a classic Seaport tip).
        OrderParameters memory tip = _flatParams(holder, 2 ether);
        ConsiderationItem[] memory c = new ConsiderationItem[](2);
        c[0] = _native(2 ether, holder);
        c[1] = _native(0.5 ether, keeper); // the tip, paid to the keeper
        tip.consideration = c; // totalOriginalConsiderationItems stays 1
        vm.prank(keeper);
        vm.expectRevert(Cocoon.BadOrder.selector);
        cocoon.buySeat(AdvancedOrder(tip, 1, 1, "", ""), noResolvers);

        // A consideration item paid to Cocoon itself.
        OrderParameters memory back = _flatParams(holder, 2.8 ether);
        ConsiderationItem[] memory c2 = new ConsiderationItem[](2);
        c2[0] = _native(2.8 ether - 1, holder);
        c2[1] = _native(1, address(cocoon));
        back.consideration = c2;
        back.totalOriginalConsiderationItems = 2;
        vm.prank(keeper);
        vm.expectRevert(Cocoon.BadOrder.selector);
        cocoon.buySeat(AdvancedOrder(back, 1, 1, "", ""), noResolvers);
    }

    /// Buy a seat, sell it through the falling order, settle, then buy the SAME seat again. The
    /// repurchase is round 1, its orders validate, and the first round's orders are dead.
    function test_repurchaseIncrementsTheRoundWithoutColliding() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        _holderListsTerms(
            holder, SeatListing.Terms(2.8 ether, 10_000, 10_000, 7 days, uint40(block.timestamp), 0)
        );
        _report(2.8 ether);
        cocoon.depositTax{value: 10 ether}();
        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(_flatParams(holder, 2.8 ether), 1, 1, "", ""), noResolvers);
        (,,,,,, uint16 round0) = cocoon.seats(SEAT);
        assertEq(round0, 0);

        // The buyer takes the falling order a week in and sends nothing back.
        vm.warp(block.timestamp + 7 days);
        _buyerTakesTheFallingOrder();
        assertEq(collection.ownerOf(SEAT), buyer);

        // Capture the first round's order hashes, then settle (which cancels them).
        bytes32[2] memory firstHashes = _ourOrderHashes();
        cocoon.settleSeat(SEAT);
        assertEq(cocoon.heldCount(), 0);

        // The buyer relists and the vault buys the same seat back.
        OrderParameters memory relist = _holderListsTerms(
            buyer, SeatListing.Terms(2.8 ether, 10_000, 10_000, 7 days, uint40(block.timestamp), 0)
        );
        _report(2.8 ether); // newer issue time, same value: within the rise limit
        cocoon.depositTax{value: 10 ether}();
        vm.prank(keeper);
        cocoon.buySeat(AdvancedOrder(relist, 1, 1, "", ""), noResolvers);

        (,,,,,, uint16 round1) = cocoon.seats(SEAT);
        assertEq(round1, 1, "the repurchase is round 1");
        assertEq(collection.ownerOf(SEAT), address(cocoon));

        bytes32[2] memory secondHashes = _ourOrderHashes();
        assertTrue(secondHashes[0] != firstHashes[0], "round 1 salts differ from round 0");
        assertTrue(secondHashes[1] != firstHashes[1]);
        for (uint256 i; i < 2; i++) {
            (bool validated, bool cancelled,,) = seaport.getOrderStatus(secondHashes[i]);
            assertTrue(validated, "round 1 orders are live");
            assertFalse(cancelled);
            (, bool oldCancelled,,) = seaport.getOrderStatus(firstHashes[i]);
            assertTrue(oldCancelled, "round 0 orders are cancelled");
        }
    }

    /// A seat transferred straight to Cocoon is taken onto the books by `adopt` at the floor and
    /// listed; a safe-transfer from outside a purchase (here, a foreign collection) is refused.
    function test_adoptTakesADirectTransferAndRefusesAnUnsolicitedSafeTransfer() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        address holder = collection.ownerOf(SEAT);
        _report(2.8 ether);

        vm.prank(holder);
        collection.transferFrom(holder, address(cocoon), SEAT);
        assertEq(collection.ownerOf(SEAT), address(cocoon));

        cocoon.adopt(SEAT);
        (uint128 cost,,,,, bool held, uint16 round) = cocoon.seats(SEAT);
        assertEq(cost, 2.8 ether, "adopted at the floor");
        assertTrue(held);
        assertEq(round, 0);
        assertEq(cocoon.heldCount(), 1);
        _assertOurOrdersAreValidated();

        // A safe-transfer of some other token, not part of a purchase, is refused by the receiver.
        MockERC721 foreign = new MockERC721();
        foreign.mint(address(this), 1);
        vm.expectRevert(Cocoon.UnexpectedToken.selector);
        foreign.safeTransferFrom(address(this), address(cocoon), 1);
    }

    // ------------------------------------------------------------------ helpers

    function _holderLists(address holder, uint256 price) internal returns (OrderParameters memory) {
        Order[] memory listing = new Order[](1);
        listing[0] = Order(
            SeatListing.parameters(
                holder,
                COLLECTION,
                SEAT,
                SeatListing.Terms(price, 10_000, 10_000, 7 days, uint40(block.timestamp), 0),
                0
            ),
            ""
        );
        vm.startPrank(holder);
        collection.setApprovalForAll(SEAPORT, true);
        assertTrue(seaport.validate(listing));
        vm.stopPrank();
        return listing[0].parameters;
    }

    /// @dev Lists SEAT for the given terms, validated as the holder on the live Seaport.
    function _holderListsTerms(address holder, SeatListing.Terms memory t)
        internal
        returns (OrderParameters memory p)
    {
        p = SeatListing.parameters(holder, COLLECTION, SEAT, t, 0);
        _validateAs(holder, p);
    }

    function _flatParams(address holder, uint256 price) internal view returns (OrderParameters memory) {
        return SeatListing.parameters(
            holder,
            COLLECTION,
            SEAT,
            SeatListing.Terms(price, 10_000, 10_000, 7 days, uint40(block.timestamp), 0),
            0
        );
    }

    function _validateAs(address offerer, OrderParameters memory p) internal {
        Order[] memory o = new Order[](1);
        o[0] = Order(p, "");
        vm.startPrank(offerer);
        collection.setApprovalForAll(SEAPORT, true);
        assertTrue(seaport.validate(o));
        vm.stopPrank();
    }

    function _native(uint256 amount, address to) internal pure returns (ConsiderationItem memory) {
        return ConsiderationItem(ItemType.NATIVE, address(0), 0, amount, amount, payable(to));
    }

    /// @dev The order hashes of our two current listings for SEAT, on the live Seaport's counter.
    function _ourOrderHashes() internal view returns (bytes32[2] memory out) {
        OrderComponents[] memory ours = SeatListing.components(
            address(cocoon), COLLECTION, SEAT, _ourTerms(), seaport.getCounter(address(cocoon))
        );
        out[0] = seaport.getOrderHash(ours[0]);
        out[1] = seaport.getOrderHash(ours[1]);
    }

    function _assertBalanceIdentity() internal view {
        assertEq(
            address(cocoon).balance,
            cocoon.seatPot() + cocoon.burnPot() + cocoon.developerBalance() + cocoon.imdBurnBalance()
                + strayWei,
            "balance identity (plus the forced-in stray that skim would book)"
        );
    }

    function _ourTerms() internal view returns (SeatListing.Terms memory) {
        (uint128 cost, uint40 boughtAt, uint16 startX, uint16 endX, uint32 decay,, uint16 round) =
            cocoon.seats(SEAT);
        return SeatListing.Terms(cost, startX, endX, decay, boughtAt, round);
    }

    function _assertOurOrdersAreValidated() internal view {
        OrderComponents[] memory ours =
            SeatListing.components(address(cocoon), COLLECTION, SEAT, _ourTerms(), 0);
        for (uint256 i; i < 2; i++) {
            (bool isValidated, bool isCancelled,,) = seaport.getOrderStatus(seaport.getOrderHash(ours[i]));
            assertTrue(isValidated, "validated on the live Seaport");
            assertFalse(isCancelled);
        }
    }

    function _buyerTakesTheFallingOrder() internal {
        Order[] memory orders = SeatListing.orders(address(cocoon), COLLECTION, SEAT, _ourTerms());
        vm.prank(buyer);
        assertTrue(
            seaport.fulfillAdvancedOrder{value: 3.65 ether}(
                AdvancedOrder(orders[0].parameters, 1, 1, "", ""), noResolvers, bytes32(0), buyer
            )
        );
    }

    function _assertTheTailIsCancelled() internal view {
        OrderComponents[] memory ours =
            SeatListing.components(address(cocoon), COLLECTION, SEAT, _ourTerms(), 0);
        (, bool cancelled,,) = seaport.getOrderStatus(seaport.getOrderHash(ours[1]));
        assertTrue(cancelled, "the flat tail is cancelled");
    }

    function _report(uint256 floorWei) internal {
        OracleAttestation.Attestation memory a;
        a.requestId = bytes32(block.timestamp);
        a.chainId = 1;
        a.questionHash = QUESTION;
        a.answerType = OracleAttestation.ANSWER_TYPE_UINT256;
        a.answer = abi.encode(floorWei);
        a.panelSize = 5;
        a.quorum = 4;
        a.agreed = 4;
        a.issuedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 24 hours);
        bytes32 sep = OracleAttestation.domainSeparator(block.chainid, address(feed));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, OracleAttestation.digest(sep, a));
        feed.report(a, abi.encodePacked(r, s, v));
    }
}
